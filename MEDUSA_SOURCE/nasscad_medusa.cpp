// nasscad_medusa.cpp — NASSCAD MEDUSA ENGINE 3.1 : compagnon natif localhost (OCCT C++).
// Un seul fichier, un seul binaire — ce fichier EST le moteur (parsing STEP,
// tessellation, CSG, smoothing, repair), pas un "booster" separe greffe a
// cote : plus simple a maintenir, une seule chose a recompiler/versionner.
// Implémente le protocole NSTP v1 tel que spécifié dans step-import.js :
//   ['NSTP'|u32 ver|u32 jsonLen|u32 binLen][JSON padded%4][BIN: pos+idx par mesh]
// Endpoints :
//   GET  /ping   -> détection au boot (JSON court, latence minimale)
//   POST /step   -> body = fichier STEP brut -> réponse = buffer NSTP v1
//   POST /ifc    -> body = fichier IFC brut  -> réponse = buffer NSTP v1
//                   (/step renifle aussi l'IFC : un seul depot suffit)
//   OPTIONS *    -> préflight CORS (ACAO:*, Private-Network-Access)
// Bind strict 127.0.0.1 — jamais 0.0.0.0. Usage local mono-utilisateur uniquement.
// [15/08] Tessellation STEP parallélisée (pool de threads, verrou par TShape
// partagé) + logging console/fichier bufferisé (TeeStreambuf) — voir les
// commentaires datés [15/08] plus bas pour le détail des deux changements.

#include <STEPCAFControl_Reader.hxx>
#include <STEPControl_Writer.hxx>        // [24/09] export exact : B-Rep d'origine reecrit par OCCT
#include <STEPCAFControl_Writer.hxx>     // [24/09] --selftest-stepexport : fichier source a instances
#include <STEPConstruct.hxx>
#include <XSControl_WorkSession.hxx>
#include <XSControl_TransferWriter.hxx>
#include <Transfer_FinderProcess.hxx>
#include <StepData_StepModel.hxx>
#include <StepRepr_RepresentationItem.hxx>
#include <Interface_Static.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <STEPControl_Reader.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_ExtendedString.hxx>
#include <Quantity_Color.hxx>
#include <Quantity_TypeOfColor.hxx>   // [26/08] Quantity_TOC_sRGB (explicite, cf. occtColorToSRGB)
#include <Quantity_ColorRGBA.hxx>      // [18/09] canal alpha — Quantity_Color n'en a pas
#include <TopoDS_Shape.hxx>
#include <TopoDS_Face.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <manifold/manifoldc.h>
#include <unordered_map>
#include <unordered_set>
#include <ShapeFix_Shape.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressScope.hxx>
#include <Message_ProgressRange.hxx>   // [17/09] annulation propre de BRepMesh
#include <IMeshTools_Parameters.hxx>   // [17/09] seul constructeur qui accepte une ProgressRange
#include <cmath>
// [22/09] dependances du lecteur IFC natif (namespace nasifc)
#include <array>
#include <gp_Ax1.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <gp_Ax3.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <gp_Circ.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_NurbsConvert.hxx>   // [24/09] banc de la garde des B-splines periodiques
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Shell.hxx>
#include <string_view>
#include <thread>
#include <future>
#ifndef _WIN32
  // sys/sysinfo.h (struct sysinfo / sysinfo()) est une API glibc/Linux —
  // absente de MSVC ET de MinGW-w64. Version Windows de readAvailableRamMB()
  // plus bas : GlobalMemoryStatusEx (windows.h, inclus dans le bloc _WIN32
  // ci-dessous) n'en a de toute facon pas besoin.
  #include <sys/sysinfo.h>
#endif
#include <cstdlib>
#include <new>          // [01/09] std::bad_alloc — leve par ManifoldArena
#include <fstream>
#include <sstream>
#include <mutex>
#include <condition_variable> // [24/09] export STEP en flux ordonne (stepx::streamExport)
#include <charconv>           // [24/09] std::to_chars — reels du writer STEP natif
#include <random>             // [24/09] nonce de session du cache d'import (ImportEntry)
#include <filesystem>         // [24/09] fichier temporaire (writer OCCT < 7.7 sans WriteStream, banc --selftest-stepexport)
#include <tuple>              // [24/09] cle des prototypes de l'export exact (MSVC : pas d'include transitif garanti)
#include <deque>        // [04/09] tampon circulaire du journal — voir gLogRing
#include <atomic>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <Bnd_Box.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Tool.hxx>
#include <Poly_Triangulation.hxx>
#include <Poly_PolygonOnTriangulation.hxx>  // [21/09] couture par topologie — cf. extractIntoTopo
#include <BRep_TEdge.hxx>                   // [FIX 27/09] les DEUX polygones d'une couture, cf. etage A
#include <BRep_CurveRepresentation.hxx>
#include <BRepTools.hxx>                    // [FIX 27/09] faces sans triangulation, cf. etage A'
#include <BRepTools_WireExplorer.hxx>
#include <GCPnts_TangentialDeflection.hxx>
#include <BRepPrimAPI_MakeBox.hxx>          // [21/09] --selftest-weld
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepGProp.hxx>                    // [21/09] volume exact du B-Rep (reference du banc)
#include <GProp_GProps.hxx>
#include <gp_Vec.hxx>
#include <cstdint>
#include <algorithm>
#include <utility>
#include <TopLoc_Location.hxx>
#include <gp_Pnt.hxx>
// [16/09] Métrologie par corps pour la déflection adaptative : on interroge la
// géométrie ANALYTIQUE des faces et des arêtes (rayons exacts, sans mailler) et
// les sommets B-Rep (taille réelle, sans passer par l'enveloppe des pôles).
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <GeomAbs_CurveType.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Cone.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <Precision.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Standard_Version.hxx>  // OCC_VERSION_COMPLETE -> version OCCT dans /ping

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>   // GlobalMemoryStatusEx (readAvailableRamMB) — inclus APRES
                          // winsock2.h/ws2tcpip.h, ordre obligatoire pour eviter le
                          // conflit de redefinition winsock.h vs winsock2.h.
  #ifndef CP_UTF8
    // [FIX compilation] Sur certains toolchains MinGW-w64, windows.h ne tire
    // pas systematiquement winnls.h (selon version du SDK/ordre d'inclusion
    // avec winsock2.h ci-dessus) : SetConsoleOutputCP() reste visible (declare
    // ailleurs) mais pas la macro CP_UTF8. 65001 est la valeur numerique fixe
    // de cette codepage, stable et documentee sur toutes les versions de
    // Windows -- ce repli compile a l'identique que la macro SDK soit
    // presente ou non (#ifndef evite toute redefinition en conflit).
    #define CP_UTF8 65001
  #endif
  #pragma comment(lib, "ws2_32.lib")
  // [24/09] Rapport de plantage (cf. crashrep) : types seulement. MiniDumpWriteDump
  // et K32GetProcessMemoryInfo sont resolues a l'execution (LoadLibrary /
  // GetProcAddress) : aucune bibliotheque de plus a lier, sur MSVC comme MinGW.
  #include <dbghelp.h>
  #include <psapi.h>
  typedef SOCKET SocketFD;
  #define NASSCAD_SOCK_INVALID INVALID_SOCKET
  static void nasscadCloseSocket(SocketFD s){ closesocket(s); }
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h> // [PERF 18/08] TCP_NODELAY (cf. accept() dans main()) — absent de netinet/in.h
  #include <arpa/inet.h>
  #include <sys/time.h>   // [28/08 AUDIT] struct timeval — SO_RCVTIMEO/SO_SNDTIMEO (cf. accept() dans main())
  #include <unistd.h>
  #include <csignal>
  #include <fcntl.h>      // [24/09] rapport de plantage (open/O_*), cf. crashrep
  #if defined(__GLIBC__)
    #include <execinfo.h> // [24/09] pile du thread fautif dans le rapport de plantage
  #endif
  typedef int SocketFD;
  #define NASSCAD_SOCK_INVALID (-1)
  static void nasscadCloseSocket(SocketFD s){ close(s); }
#endif
#include <cstring>
#include <cstdio>
#include <cstdint>
#include <cstdarg>      // [24/09] crashrep::Out::pf
#include <cerrno>       // [24/09] errno — crashrep (creation exclusive du rapport)
#include <csignal>      // [24/09] SIGABRT (crashrep), aussi sous Windows
#include <cctype>   // [28/08] std::isspace — stepHeaderInfo (parsing de l'en-tete STEP)
#include <string>
#include <vector>
#include <sstream>
#include <iostream>
#include <chrono>
#include <ctime>
#include <map>          // [19/09] nasifc::Reader::unsupported
#include <set>          // [19/09] parcours des styles IFC
#include <algorithm>
#include <optional>
#include <memory>

using Clock = std::chrono::high_resolution_clock;
static double ms(Clock::time_point a, Clock::time_point b) {
    return std::chrono::duration<double, std::milli>(b - a).count();
}

// [15/08] Mutex console/log unique — protège TOUTE écriture std::cerr
// atteignable depuis un thread de travail (tessellation parallèle, cf. plus
// bas) ainsi que la globale gBarActive/gLastBarLen (barres de progression)
// qu'elles mutent. Sans lui, deux threads tessellant deux pièces en parallèle
// et loggant chacun une ligne [REPAIR]/[MANIFOLD-RAW] en même temps
// corrompraient l'état interne de TeeStreambuf (course sur atLineStart_/
// ansiState_/gBarActive), pas juste l'affichage. Les points d'appel restés
// mono-thread (ConsoleProgress::Show pendant le PARSING, encodeNSTP après le
// join des threads) ne le prennent pas : aucune concurrence possible là.
static std::mutex gConsoleMutex;

// [15/08 FIX v4] Declaration anticipee — definition complete plus bas (a cote
// de drawBarLine/barPhaseStart, dont elle partage l'esprit). Necessaire ici
// car logRawManifoldCheck (juste en dessous) l'utilise avant ce point du
// fichier.
static void logFileOnly(const std::string& msg);
// [15/08 FIX v5] Compteur MANIFOLD-RAW — declare ICI (avant logRawManifoldCheck
// qui l'incremente) plutot qu'a cote de gRepairedCount (bien plus bas dans le
// fichier, apres logRawManifoldCheck). Lu par le suffixe de la barre
// TESSELLATION, cf. son commentaire pres de gRepairedCount.
static std::atomic<int> gManifoldIssueCount{0}; // reset par requete dans processStepBuffer

// ─────────────────────────────────────────────────────────────────────────
// Structures internes
// ─────────────────────────────────────────────────────────────────────────
struct MeshData {
    std::string name;
    bool hasColor = false;
    float r = 0, g = 0, b = 0;
    // [18/09] Opacite du corps, 1 = opaque. Le fichier STEP l'ecrit dans la meme
    // chaine de style que la couleur (SURFACE_STYLE_RENDERING_WITH_PROPERTIES ->
    // SURFACE_STYLE_TRANSPARENT), et XCAF la rend par Quantity_ColorRGBA::Alpha().
    // Elle ne traversait aucun etage du pipeline : un corps semi-transparent
    // arrivait opaque au client, quel que soit le lecteur.
    float a = 1.0f;
    std::vector<float> positions;   // x,y,z interleaved
    std::vector<uint32_t> indices;
    // [27/08] Couleur PAR FACE — miroir exact de DiffuseColor de FreeCAD
    // (ViewProviderPartExt) : une entree par face topologique, dans l'ordre du
    // TopExp_Explorer, chacune pointant sa plage contigue du buffer d'index.
    //
    // Convention identique a FreeCAD : le tableau est VIDE quand le solide est
    // monochrome (equivalent d'un DiffuseColor a une seule entree), et de
    // longueur nbFaces des qu'il porte au moins deux couleurs distinctes — y
    // compris pour les faces non stylees, qui recoivent la couleur du solide.
    //
    // On garde l'identite des faces plutot que de fusionner par couleur : c'est
    // ce qui permettra de selectionner et recolorer UNE face. La fusion en
    // appels de dessin se fait cote client, a l'affichage, ou elle est gratuite
    // et reversible.
    struct FaceRange { float r, g, b; uint32_t start, count; float a = 1.0f; };
    std::vector<FaceRange> faces;
    // [24/09] Reference du corps EXACT dans le cache d'import de MEDUSA
    // (« <tag import>:<rang> », cf. ImportEntry). Le client la garde sur l'objet
    // et la renvoie a l'export : le B-Rep d'origine est alors reecrit tel quel
    // au lieu du maillage. Vide = pas de B-Rep exact (IFC, maillage pur).
    std::string ref;
    // [FIX 27/09] Ce que le B-Rep du corps DECLARE, par la seule topologie :
    // chaque arete comptee sur les faces qui la bordent (une couture compte deux
    // fois). « closed » : toutes a deux ; « open » : au moins une a un ;
    // « nonmanifold » : au moins une a plus de deux. Le pendant, corps par corps,
    // de step-declare.js (qui ne sait repondre que pour le fichier entier).
    // Vide = inconnu (IFC maille, chemin legacy) : le champ n'est pas emis.
    std::string brep;
};

// [27/08] Couleur resolue d'UNE face, et carte face -> couleur d'un solide.
// Cle = pointeur TShape de la face : stable a travers Moved() (qui ne change que
// la Location) et a travers l'eclatement en sous-solides, donc utilisable depuis
// la phase B parallele alors que la carte est construite en phase A, seule phase
// autorisee a toucher le document XCAF. Une face reparee par ShapeFix recoit un
// nouveau TShape : elle sort simplement de la carte et retombe sur la couleur du
// solide — degradation propre, jamais d'erreur.
// [18/09] `a` = opacite (1 = opaque). Initialiseur par defaut : les
// constructions FaceRGB{r,g,b} existantes restent valides et veulent dire opaque.
struct FaceRGB { float r, g, b; float a = 1.0f; };
typedef std::unordered_map<const void*, FaceRGB> FaceColorMap;

// [10/08] Diagnostic manifold sur le maillage BRUT sorti d'OCCT — AVANT toute
// reparation cote client (sewing/gap-fill/cap, qui vit dans step-import.js,
// pas ici). Repond a une question qu'on ne pouvait pas trancher jusqu'ici :
// le trou existe-t-il DEJA dans ce que MEDUSA envoie, ou apparait-il plus
// tard dans le pipeline navigateur ? Meme principe que les tests de
// hollowbox de ce soir : chaque arete = paire de sommets, compte les
// triangles qui la referencent — 2 = watertight, != 2 = arete nue/sur-valencee.
static void logRawManifoldCheck(const MeshData& md) {
    if (md.indices.size() < 3) return;
    std::unordered_map<uint64_t, int> edgeCount;
    edgeCount.reserve(md.indices.size());
    auto edgeKey = [](uint32_t a, uint32_t b) -> uint64_t {
        if (a > b) std::swap(a, b);
        return ((uint64_t)a << 32) | (uint64_t)b;
    };
    for (size_t t = 0; t + 2 < md.indices.size(); t += 3) {
        uint32_t i0 = md.indices[t], i1 = md.indices[t+1], i2 = md.indices[t+2];
        edgeCount[edgeKey(i0,i1)]++;
        edgeCount[edgeKey(i1,i2)]++;
        edgeCount[edgeKey(i2,i0)]++;
    }
    int naked = 0, overValenced = 0;
    for (const auto& kv : edgeCount) {
        if (kv.second == 1) naked++;
        else if (kv.second > 2) overValenced++;
    }
    if (naked > 0 || overValenced > 0) {
        gManifoldIssueCount++; // [15/08 FIX v5] lu par le suffixe de la barre TESSELLATION
        std::lock_guard<std::mutex> lk(gConsoleMutex); // [15/08] atteignable depuis un thread de tessellation parallèle
        // [15/08 FIX v4] fichier uniquement — la barre TESSELLATION reste
        // seule sur la console (cf. logFileOnly), le detail complet reste
        // dans medusa.log comme avant.
        std::ostringstream oss;
        oss << "[MANIFOLD-RAW] \"" << md.name.substr(0,40) << "\" ALREADY has holes as it leaves OCCT (before any browser-side repair) : "
            << naked << " naked edge(s), " << overValenced << " over-valenced edge(s), "
            << (md.indices.size()/3) << " triangle(s)\n";
        logFileOnly(oss.str());
    }
}

static std::string extendedStringToUtf8(const TCollection_ExtendedString& s) {
    char buf[4096];
    Standard_PCharacter p = buf;
    // ToUTF8CString tronque proprement au-delà de la capacité fournie ; les noms
    // de pièces STEP dépassent rarement quelques dizaines de caractères.
    s.ToUTF8CString(p);
    return std::string(buf);
}

// Tessellise une shape déjà chargée et pousse le résultat dans `out` (un mesh par shape).
// Tessellation façon occt-import-js (référence de compatibilité NASSCAD) :
// linearDeflection = ratio 0.001 × taille moyenne bbox de la shape racine,
// plancher 1 mm, angularDeflection 0.5 rad — appliquée UNE fois par racine
// (les instances répétées partagent leur TShape donc leur maillage : ne pas
// re-tesselliser par solide, c'est du calcul perdu et un compte différent).
static double rootDeflectionLikeOcctImportJs(const TopoDS_Shape& rootShape) {
    Bnd_Box bb;
    BRepBndLib::Add(rootShape, bb, false);
    double linDefl = 1.0; // plancher 1 mm (comportement occt-import-js)
    if (!bb.IsVoid()) {
        Standard_Real x0,y0,z0,x1,y1,z1;
        bb.Get(x0,y0,z0,x1,y1,z1);
        double avgSize = ((x1-x0)+(y1-y0)+(z1-z0)) / 3.0;
        double d = avgSize * 0.001;
        if (d > Precision::Confusion()) linDefl = d;
    }
    // [FIX 16/09 — Nass] CORRECTION du garde-fou du 14/09, qui visait un fantôme.
    //
    // Le commentaire précédent affirmait qu'une pièce parasite à 9,1 km faisait
    // exploser la bbox racine du Scania jusqu'à 11 154 mm d'étendue moyenne, d'où
    // une déflection de 11 m. Audit complet du fichier (voir ANALYSE_DEFLECTION/,
    // outil step_deflect_audit.py) : c'était FAUX.
    //   - Les 232 points à plusieurs kilomètres existent bien, mais ce sont des
    //     origines de LINE infinies et d'AXIS2_PLACEMENT_3D. OCCT ne les met
    //     JAMAIS dans une bbox : BndLib borne toujours sur l'intervalle
    //     paramétrique rogné de l'arête ou de la face.
    //   - L'étendue moyenne réelle de la racine du Scania vaut 6 507 mm, et la
    //     déflection produite ici 6,51 mm — pas 11 m. Le plafond DEFL_MAX = 25 mm
    //     ne se déclenchait donc jamais : il ne corrigeait rien, d'où « ça soude
    //     toujours ».
    //
    // Le vrai défaut n'est pas l'échelle de cette valeur, c'est sa PORTÉE : une
    // déflection unique calculée sur l'assemblage entier, puis appliquée à des
    // corps dont la taille s'étale de 3 mm à 6,4 m (rapport 1 à 2 131). Mesuré :
    // le corps médian du Scania reçoit une tolérance égale à 4,8 % de sa propre
    // taille (p90 : 17 %, max : 217 % — plus grande que la pièce elle-même), et
    // 688 corps sur 859 dépassent 1 %. C'est ce que corrige bodyDeflection
    // plus bas, qui redonne à chaque corps l'instrument de mesure à son échelle.
    //
    // Cette fonction-ci subsiste pour deux usages : compatibilité occt-import-js,
    // et surtout PLAFOND de référence — aucun corps ne sera jamais maillé plus
    // grossièrement que cette valeur, donc la nouvelle politique ne peut pas être
    // pire que l'ancienne, sur aucune pièce. Le plancher reste utile ; le plafond
    // DEFL_MAX est retiré (il bornait un débordement qui n'existe pas).
    // Le mode « déflection forcée » (argv[2] / ?deflection=) reste prioritaire :
    // il court-circuite tout ceci via gDeflectionOverride.
    const double DEFL_MIN = 0.005;  // mm — évite une finesse absurde
    if (linDefl < DEFL_MIN) linDefl = DEFL_MIN;
    return linDefl;
}

// ══════════════════════════════════════════════════════════════════════════
// [17/09] LA DEFLEXION DE FREECAD, A LA LETTRE.
//
// Le 16/09 avait invente une formule maison :
//     d = clamp( min(K x diagonale, 0.25 x rayon median), 1e-4 x L, dRef )
// avec K = 0.0015. Elle demandait deux parcours topologiques COMPLETS par
// corps — tous les sommets, puis toutes les faces et toutes les aretes — dans
// la phase sequentielle, et elle n'avait jamais ete comparee a une reference.
//
// FreeCAD, lui, fait ceci, et le documente (wiki, propriete Deviation d'un
// Part Feature) : « the deviation is a value in percentage that is related to
// the dimensions in millimeters of the bounding box of the object »
//     deflexion = (w + h + d)/3 x Deviation/100      Deviation = 0,5 % par defaut
//     Angular Deflection = 28,5 deg = 0,4974 rad
// Par OBJET, pas par assemblage. C'est tout. Pas de rayon median, pas de
// terme de silhouette, pas de plancher relatif.
//
// Le balayage du 17/09 sur Scania-8x4 (281 Mo, 1451 corps) a retrouve cette
// valeur tout seul : le genou de la courbe taille-de-maillage/temps est a
// K = 0,003 sur la DIAGONALE, et pour un corps grossierement cubique de cote a
// la diagonale vaut 1,732 a tandis que (w+h+d)/3 vaut a — donc
//     K_diagonale 0,003  ==  Deviation 0,5 %  a 4 % pres.
// Deux chemins independants, le meme chiffre. On prend celui qui a vingt ans
// de kilometrage et une documentation.
//
// Ce qu'on garde de l'ancienne formule, et pourquoi :
//   - la bbox des SOMMETS et non BRepBndLib. FreeCAD utilise la bbox de la
//     shape, bornee par les poles des NURBS ; mesure sur ce meme Scania, elle
//     surestime d'un facteur 3,65 (5 472 mm de poles pour 1 497 mm de
//     geometrie reelle). Meme formule, entree plus juste.
//   - le plafond dRef : garantie de non-regression, aucun corps ne sera jamais
//     maille plus grossierement que ne le faisait la deflexion globale.
//   - un plancher absolu minuscule, pour ne pas diviser par zero sur un corps
//     degenere.
// Ce qu'on jette : medianAnalyticRadius (un parcours faces + aretes par corps,
// en phase sequentielle, pour un terme que FreeCAD n'a pas).
// ══════════════════════════════════════════════════════════════════════════
static double gDeviation = 0.005;   // = Deviation 0,5 % de FreeCAD (argv[3], ?deviation=, ?k=)
// 28,5 deg exactement, la valeur par defaut d'Angular Deflection de FreeCAD.
// L'ancien 0,5 rad code en dur valait 28,6479 deg : le meme reglage, ecrit par
// quelqu'un qui ne savait pas qu'il recopiait FreeCAD.
static const double ANGULAR_DEFLECTION = 0.497419;

// Taille moyenne (w+h+d)/3 ET diagonale de la boite du corps, en UN seul
// parcours. Renvoie false si le corps n'a aucun sommet.
//
// [FIX 17/09 soir — Nass] La boite des SEULS sommets s'effondre sur les surfaces
// periodiques fermees. Un tore (joint torique) n'a qu'UN sommet : boite nulle,
// d = plancher = 1e-6 mm, maillage infini. Constate sur Scania-8x4 :
// « gniazdo15PIN_uszczelnienie1 » (1 face torique, 1 sommet) et les joints
// d'« OverHearts3 » — annulation ignoree (une seule face), thread detache,
// +2 Go en 45 s, un coeur perdu. Un cylindre plein (2 sommets sur la couture)
// donne sa seule hauteur : rondelle D100xH5 maillee 41x trop fin.
// Remede : trois points INTERIEURS par arete, pris sur la COURBE (BRepAdaptor),
// donc toujours pas sur les poles des NURBS — l'avantage de la boite des
// sommets est conserve. Mesure sur les corps du Scania (OCCT 8.0.1) :
//   gniazdo...  sommets 0      -> sommets+aretes 33,67  (BndLib 39,61)
//   Spring      sommets 7,33   -> 35,00                 (BndLib 36,05)
//
// [FIX 17/09 soir] La mesure se fait dans le repere du PROTOTYPE (location
// retiree). Une boite alignee sur les axes depend de l'orientation : deux
// instances tournees differemment d'un meme prototype recevaient deux d
// differents (Spring : 0,053 mm dans le log, 0,037 dans son propre repere) et,
// partageant le meme TShape, se remaillaient l'une l'autre. Sans location, la
// valeur ne depend plus que de la forme — ce que le commentaire de la phase B
// affirmait deja, et qui n'etait pas vrai.
static bool vertexBoxMetrics(const TopoDS_Shape& located, double& avgSize, double& diagonal) {
    const TopoDS_Shape s = located.Located(TopLoc_Location());
    bool any = false;
    double x0=0, y0=0, z0=0, x1=0, y1=0, z1=0;
    auto add = [&](const gp_Pnt& p) {
        if (!any) { x0 = x1 = p.X(); y0 = y1 = p.Y(); z0 = z1 = p.Z(); any = true; return; }
        if (p.X() < x0) x0 = p.X(); else if (p.X() > x1) x1 = p.X();
        if (p.Y() < y0) y0 = p.Y(); else if (p.Y() > y1) y1 = p.Y();
        if (p.Z() < z0) z0 = p.Z(); else if (p.Z() > z1) z1 = p.Z();
    };
    for (TopExp_Explorer ex(s, TopAbs_VERTEX); ex.More(); ex.Next())
        add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
    if (!any) { avgSize = diagonal = 0.0; return false; }
    for (TopExp_Explorer ex(s, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge e = TopoDS::Edge(ex.Current());
        if (BRep_Tool::Degenerated(e) || !BRep_Tool::IsGeometric(e)) continue;
        try {
            BRepAdaptor_Curve c(e);
            const double u0 = c.FirstParameter(), u1 = c.LastParameter();
            if (Precision::IsInfinite(u0) || Precision::IsInfinite(u1)) continue;
            add(c.Value(u0 + 0.25 * (u1 - u0)));
            add(c.Value(u0 + 0.50 * (u1 - u0)));
            add(c.Value(u0 + 0.75 * (u1 - u0)));
        } catch (...) { /* arete sans courbe exploitable : les sommets suffisent */ }
    }
    const double dx = x1-x0, dy = y1-y0, dz = z1-z0;
    avgSize  = (dx + dy + dz) / 3.0;
    diagonal = std::sqrt(dx*dx + dy*dy + dz*dz);
    return true;
}

// Deflexion a appliquer a CE corps. `dRef` est la deflexion de sa racine (plafond).
static double bodyDeflection(const TopoDS_Shape& part, double dRef) {
    double avgSize = 0.0, diag = 0.0;
    if (!vertexBoxMetrics(part, avgSize, diag)) return dRef;  // corps sans sommet : on ne sait rien
    double d = avgSize * gDeviation;                          // la formule de FreeCAD, telle quelle
    // [FIX 17/09 soir] Plancher de 1 micron, et non plus 10 x Confusion (1e-6 mm) :
    // ce dernier ne protegeait que de la division par zero, pas de l'impossible.
    // Mesure OCCT : un tore R10 r1,5 se maille en 1,8 s a 0,001 mm, et ne rend
    // plus la main a 0,0001. Aucun ecran n'affiche un micron.
    const double dmin = 0.001;
    if (d < dmin) d = dmin;
    if (d > dRef) d = dRef;                                   // non-regression : jamais plus grossier que la racine
    return d;
}
// Application PAR SOLIDE (pas par racine) : meme deflection donc meme compte de
// triangles que le kador, mais ~2x plus rapide ici — les TShapes partages ne sont
// mailles qu'une fois de toute facon (cache Poly_Triangulation), et la passe
// unique sur la racine s'est revelee structurellement plus lente (26-28s vs 14s,
// mesure 2 runs). Compat occt-import-js = deflection identique, pas le decoupage
// interne des appels BRepMesh.
static double gRootDeflection = 1.0;
static double gDeflectionOverride = -1.0; // <=0 : auto (ratio bbox) ; >0 : force cette valeur
// ─── Réparation B-Rep ciblée (état de l'art : réparer AVANT tessellation) ───
// Détection rapide : arêtes libres (free bounds) = shells ouverts = futur
// non-manifold garanti côté mesh. Seules les pièces détectées ouvertes passent
// par ShapeFix_Shape (coûteux) — les saines (99%+) ne paient rien. C'est ce que
// Fusion/SolidWorks font en silence à l'import ; le gap-fill mesh côté NASSCAD
// reste en filet final pour ce que même ShapeFix ne recoud pas.
// [15/08] atomic : repairIfOpen est desormais appele depuis un pool de
// threads (tessellation parallele, cf. plus bas) — un int& simple ne
// survivrait pas a des increments concurrents (perte d'increments garantie).
static std::atomic<int> gRepairedCount{0}; // reset par requete dans processStepBuffer
// [15/08 FIX v5] Compteur REPAIR (reparation partielle) — meme esprit que
// gRepairedCount juste au-dessus. gManifoldIssueCount (meme famille, pour
// MANIFOLD-RAW) est declare plus haut, avant logRawManifoldCheck qui en a
// besoin. Aucun des deux ne s'affiche plus en clair sur la console
// (logFileOnly, cf. plus haut) pour ne pas interrompre la barre
// TESSELLATION, mais Nass veut quand meme un signe de vie visible pour ces
// deux evenements — pas une 2e barre a part (elle se battrait avec
// TESSELLATION pour la meme ligne, meme piege que la 1ere tentative
// RESOLUTION), mais un compteur greffe DANS le suffixe de la barre
// TESSELLATION deja existante : visible en direct, jamais de ligne en plus.
static std::atomic<int> gPartialRepairCount{0}; // reset par requete dans processStepBuffer
static bool hasOpenEdges(const TopoDS_Shape& s) {
    ShapeAnalysis_FreeBounds fb(s);
    const TopoDS_Compound& open = fb.GetOpenWires();
    if (open.IsNull()) return false;
    TopoDS_Iterator it(open);
    return it.More(); // au moins un wire ouvert
}
static TopoDS_Shape repairIfOpen(const TopoDS_Shape& part, const std::string& name, std::atomic<int>& repairedCount) {
    try {
        if (!hasOpenEdges(part)) return part;
        ShapeFix_Shape fixer(part);
        // [FIX 14/09 — Nass] Tolérance bornée. Sans borne, ShapeFix recoud
        // (« sew ») avec la tolérance par défaut d'OCCT et fusionne des surfaces
        // distinctes mais proches — typiquement le vitrage d'une cabine avec son
        // montant. Scania-8x4.stp contient 44 OPEN_SHELL (vitrage, tôles
        // surfaciques) qui passent TOUS par ici. On limite le recousage aux vrais
        // micro-jeux numériques ; ce qui ne se recoud pas sous cette borne repart
        // en « partial » et c'est le gap-fill NASSCAD qui prend le relais — bien
        // préférable à une fusion silencieuse.
        fixer.SetPrecision(Precision::Confusion());
        fixer.SetMaxTolerance(0.1);   // mm
        fixer.Perform();
        TopoDS_Shape fixed = fixer.Shape();
        if (!fixed.IsNull() && !hasOpenEdges(fixed)) {
            repairedCount++;
            std::lock_guard<std::mutex> lk(gConsoleMutex); // [15/08] atteignable depuis un thread de tessellation parallèle
            // [15/08 FIX v4] fichier uniquement — meme raison que MANIFOLD-RAW,
            // ne doit pas interrompre la barre TESSELLATION en console.
            logFileOnly("  REPAIR       [ok] \"" + name.substr(0,40) + "\" - shell re-sewn (B-Rep)\n");
            return fixed;
        }
        {
            gPartialRepairCount++; // [15/08 FIX v5] lu par le suffixe de la barre TESSELLATION
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            logFileOnly("  REPAIR       [partial] \"" + name.substr(0,40) + "\" - residual free edges, NASSCAD gap-fill will take over\n");
        }
        return fixed.IsNull() ? part : fixed;
    } catch (...) {
        return part; // la reparation ne doit JAMAIS faire echouer un import
    }
}

// [10/08] Filet de securite par piece — BRepMesh_IncrementalMesh est le SEUL
// appel bloquant de ce fichier qui vit entierement DANS OCCT, hors de notre
// controle. Incident reel documente (orbiter_tool 53/59) + reproduit ce soir
// (Orbiter-Extruder, 5 min sans le moindre mouvement) : confirme par test
// empirique de Nass, PAS lie a l'adaptive tessellation (mecanisme JS cote
// client, pour les primitives parametriques — architecture totalement
// separee du pipeline STEP/OCCT cote serveur). Sur une geometrie
// pathologique (courbe quasi-degeneree, NURBS mal parametree), le mesher
// OCCT peut s'eterniser ou ne jamais converger, sans callback de progression
// expose pour le detecter de l'exterieur.
//
// Strategie : timeout par piece (thread detache + wait_for), repli sur une
// deflexion 20x plus grossiere (donc rapide par construction — bien moins de
// triangles a produire) plutot que bloquer tout l'import. Le thread original
// continue en arriere-plan (OCCT n'expose pas d'annulation mi-calcul,
// le tuer de force risquerait de corrompre son etat interne) — mais il ne
// bloque plus l'import, et son resultat (s'il finit un jour) sera
// simplement ignore par le destructeur du thread detache.
//
// [15/08] Ce garde-fou par piece coute un std::thread OS a CHAQUE appel, y
// compris pour les pieces qui tessellisent en 2 ms — non-optimal en theorie,
// volontairement pas retouche ici : (1) une fois la boucle appelante
// parallelisee (voir parallelForIndices plus bas), une piece pathologique ne
// bloque plus QU'UN worker parmi N au lieu de tout l'import — le "blast
// radius" du probleme historique (orbiter_tool 53/59, cf. plus haut) est deja
// bien reduit par la parallelisation elle-meme ; (2) le cout de creation d'un
// thread (~10-50us sous Linux) est negligeable face aux temps de
// tessellation reels (ms a secondes par piece) — remplacer ce mecanisme par
// un pool de watchdogs partages ajouterait de la complexite (annulation,
// cycle de vie) pour un gain marginal. A revisiter seulement si un profilage
// futur montre que la creation de threads devient mesurable.
// [17/09] 60 s et non 20. Mesure sur Scania-8x4 : le corps « Spring » coute a
// peu pres le meme temps quelle que soit la deflexion (il passe a 0,065 mm et
// echoue a 0,217 mm — non monotone), et ce temps tombe pile sur les 20 s de
// l'ancien seuil. Le verdict se jouait donc a pile ou face selon la charge du
// moment, et chaque « pile » coutait une piece manquante ET un thread detache
// pour toute la vie du processus. FreeCAD n'a aucun timeout : il maille, point.
// On garde un filet — un hang reel ne doit pas figer l'import — mais large
// assez pour ne plus se declencher sur une piece simplement lente.
static const int TESSELLATE_TIMEOUT_SEC = 60;

// ═══════════════════════════════════════════════════════════════════════════
// [17/09] ANNULATION PROPRE — fin des mesheurs concurrents sur la meme shape.
//
// Le filet precedent lancait BRepMesh dans un thread, attendait, et DETACHAIT
// le thread au timeout, en affirmant que « son resultat sera simplement
// ignore ». Il ne l'est pas : BRepMesh_IncrementalMesh ecrit sa triangulation
// DANS le TShape, qui est exactement l'objet que la tentative suivante lit et
// ecrit. A la quatrieme tentative, trois BRepMesh ecrivaient encore dedans.
//
// C'est ce qui explique l'anomalie du log Scania du 17/09 : la tentative a
// 6,495 mm echoue en 10 s alors que c'est, a deux pour mille pres, la
// deflexion globale (6,51 mm) a laquelle cette meme piece passait « sans
// effort » avant le passage a la deflexion par corps. La geometrie n'avait pas
// change ; ce qui avait change, c'est le nombre de mesheurs dessus.
//
// OCCT sait etre interrompu : le constructeur
//   BRepMesh_IncrementalMesh(shape, IMeshTools_Parameters, Message_ProgressRange)
// accepte une plage de progression, et un Message_ProgressIndicator dont
// UserBreak() passe a true arrete le calcul la ou il en est. L'indicateur
// ci-dessous bascule tout seul a l'echeance.
//
// La granularite de l'annulation depend de la frequence a laquelle l'algorithme
// interroge UserBreak() — on ne la controle pas, et une face pathologique peut
// en theorie ne jamais rendre la main. Le thread + wait_for est donc CONSERVE,
// mais avec un delai de grace : l'annulation a le temps d'etre honoree, et si
// elle ne l'est pas, on detache — et dans ce cas SEULEMENT, on cesse
// definitivement de toucher cette shape. Plus jamais deux mesheurs dessus.
// ═══════════════════════════════════════════════════════════════════════════
class DeadlineProgress : public Message_ProgressIndicator {
public:
    // [17/09] steady_clock EXPLICITEMENT, et non le `Clock` du fichier.
    // `using Clock = std::chrono::high_resolution_clock` n'est pas la meme chose
    // selon la bibliotheque standard : sur MSVC c'est steady_clock, mais sur
    // libstdc++ (le g++ des builds Linux et du cross-compile MinGW) c'est un
    // alias de system_clock — l'horloge MURALE. Un ajustement NTP ou un
    // changement d'heure pendant un import de trois minutes ferait alors
    // expirer l'echeance d'un coup, ou jamais. Pour chronometrer une DUREE il
    // faut une horloge monotone ; Clock reste parfait pour ce a quoi il sert
    // partout ailleurs ici (mesurer des intervalles courts pour les logs).
    explicit DeadlineProgress(double sec)
        : myDeadline(std::chrono::steady_clock::now()
                     + std::chrono::microseconds((long long)(sec * 1e6))),
          myBroke(false) {}
    // Rien a afficher : cette barre-ci ne sert qu'a porter UserBreak().
    virtual void Show(const Message_ProgressScope&, const Standard_Boolean) override {}
    // Appele depuis les threads internes de BRepMesh (InParallel) : atomique.
    virtual Standard_Boolean UserBreak() override {
        if (!myBroke.load(std::memory_order_relaxed) && std::chrono::steady_clock::now() >= myDeadline)
            myBroke.store(true, std::memory_order_relaxed);
        return myBroke.load(std::memory_order_relaxed) ? Standard_True : Standard_False;
    }
    bool Broke() const { return myBroke.load(std::memory_order_relaxed); }
private:
    std::chrono::steady_clock::time_point myDeadline;
    std::atomic<bool> myBroke;
};

// ── [17/09] Plafond absolu de ce que la cascade a le droit de demander ──────
// DEFL_MAX (25 mm) avait ete retire le 16/09 au motif qu'il « ne se declenchait
// jamais » — vrai pour le calcul de dRef, faux pour ce chemin-ci, qui venait
// justement de naitre. La cascade x20/x200/x2000 demandait 64,95 mm sur un
// corps de 21,65 mm : trois fois la piece entiere, avec un MinSize deduit par
// OCCT a 6,5 mm, soit 30 % d'elle. A cette echelle il n'existe aucun maillage
// valide — le dernier barreau ne demandait pas quelque chose de grossier, il
// demandait quelque chose d'impossible.
// 5 % de la diagonale reelle du corps : au-dela, la corde depasse largement la
// piece et il n'y a plus de forme a produire. Ce n'est PAS un plafond de
// qualite (a ce stade la qualite a deja perdu, le choix est entre un corps
// grossier et pas de corps du tout) : c'est un plafond de FAISABILITE.
static const double DEFL_CEIL_REL = 0.05;
static const int    TESS_RETRIES  = 3;
static const double TESS_GRACE    = 1.5;   // marge laissee a l'annulation avant de detacher
// [15/08] deflection passee EXPLICITEMENT (au lieu de lire gRootDeflection,
// une globale mutable) — necessaire des que cette fonction est appelee depuis
// plusieurs threads en parallele : gRootDeflection etait ecrite par leaf AVANT
// chaque appel dans l'ancienne boucle sequentielle, ce qui n'a plus de sens
// (et serait une course) une fois N pieces traitees simultanement. Chaque
// appelant precalcule desormais sa propre deflection (celle de SA racine) en
// phase sequentielle et la transmet ici par valeur — plus aucun etat partage
// mutable lu pendant la phase parallele (gDeflectionOverride reste global
// mais n'est plus ecrit apres le debut de la requete : lecture concurrente
// sans risque).
// [16/09] Budget de triangles PAR CORPS. La déflection adaptative rend beaucoup
// de corps plus fins ; sur quelques-uns, cela suffit à produire un maillage
// disproportionné (mesuré sur le V8 : « Engine V8-XT-73 », 218 faces mais des
// NURBS très étendues, passe à lui seul de 0,4 à 2,2 M de triangles estimés).
// Plutôt que d'ESTIMER le coût avant de mailler — un modèle analytique reste une
// approximation, et se tromper là-dessus dégraderait des pièces saines — on
// maille, on COMPTE ce qui a réellement été produit, et on ne relâche que si le
// compte réel dépasse le budget. Le facteur de relâchement vient de la loi
// triangles ~ 1/d^2 : d' = d * sqrt(n / budget). Deux passes au maximum, et
// jamais au-delà de la déflection de référence — donc jamais pire qu'avant.
// 0 désactive le garde-fou.
static long long gTriBudgetPerBody = 600000;

static long long countTriangles(const TopoDS_Shape& s) {
    long long n = 0;
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        TopLoc_Location loc;
        Handle(Poly_Triangulation) t = BRep_Tool::Triangulation(TopoDS::Face(ex.Current()), loc);
        if (!t.IsNull()) n += t->NbTriangles();
    }
    return n;
}

// [16/09] Corps abandonnes faute d'avoir pu etre mailles dans les delais.
static std::atomic<int> gAbandonedCount{0};
// [17/09] Threads de maillage detaches depuis le DEMARRAGE du serveur (jamais
// remis a zero, contrairement au precedent) : chacun continue de tourner pour
// toujours et vole un coeur a tous les imports suivants. Cf. le bilan en fin
// d'import et /ping.
static std::atomic<int> gDetachedCount{0};

// [FIX 17/09 soir] Issue d'une tessellation, pour la memoire par TShape (cf.
// tessellateShape plus bas). Zombie = un mesheur detache ecrit encore dedans.
enum class TessOutcome { Done, Failed, Zombie };

// [FIX 17/09 soir] Toutes les faces portent-elles une triangulation ? Sert a
// verifier qu'une passe de budget annulee n'a pas laisse le corps a moitie vide
// (AllowQualityDecrease autorise OCCT a retirer l'ancien maillage avant de
// refaire le nouveau).
static bool allFacesTriangulated(const TopoDS_Shape& s) {
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        TopLoc_Location loc;
        if (BRep_Tool::Triangulation(TopoDS::Face(ex.Current()), loc).IsNull()) return false;
    }
    return true;
}

static TessOutcome tessellateShapeImpl(const TopoDS_Shape& located, double deflection, double deflectionCap,
                                       const std::string& bodyName, double& finalDefl) {
    // [FIX 17/09 soir — Nass] On maille le PROTOTYPE (location retiree), jamais
    // l'instance placee. La triangulation vit dans le TFace, sans location :
    // extractInto la relit ensuite pour chaque instance avec la location de sa
    // face, exactement comme avant. En revanche BRepMesh range les polygones
    // d'aretes AVEC la location de l'appel ; une instance placee ailleurs ne
    // les retrouve pas, et remaille des aretes contre des faces qu'il juge deja
    // bonnes.
    // Reproduit sur « Spring » du Scania (3 instances, un seul TShape, forme
    // non valide au sens BRepCheck) : 1re instance 0,74 s ; la 2e, meme d,
    // autre location, ne rend plus la main (> 100 s) — c'est elle, pas la
    // piece, qui faisait le zombie de 11:44:07. Prototype maille une fois,
    // puis les trois instances relues sans remaillage : 1 805 triangles
    // chacune, 0,76 s au total.
    const TopoDS_Shape shape = located.Located(TopLoc_Location());
    double d = (gDeflectionOverride > 0) ? gDeflectionOverride : deflection;
    finalDefl = d;

    // [17/09] Une passe de maillage ANNULABLE, sous filet temporel.
    // Retour false = pas terminee dans les delais. `zombie` passe a true dans le
    // seul cas ou l'annulation n'a PAS ete honoree et ou il a fallu detacher le
    // thread : la shape porte alors un mesheur vivant, et plus personne ne doit
    // la toucher. Cf. le bloc DeadlineProgress pour le pourquoi.
    bool zombie = false;
    auto meshOnce = [&shape, &zombie](double dd, double sec, bool allowDecrease = false) -> bool {
        Handle(DeadlineProgress) prog = new DeadlineProgress(sec);
        IMeshTools_Parameters mp;
        mp.Deflection = dd;
        mp.Angle      = ANGULAR_DEFLECTION;   // 28,5 deg, cf. sa definition
        mp.Relative   = Standard_False;
        mp.InParallel = Standard_True;
        // MinSize laisse a son defaut (-1 : OCCT le deduit a 0,1 x deflexion,
        // cf. IMeshTools_Parameters::RelMinSize). Ces valeurs reproduisent
        // exactement le constructeur court utilise jusqu'ici — le seul
        // changement est la ProgressRange, que ce constructeur-la n'accepte pas.
        //
        // [FIX 17/09 soir] CleanModel ne nettoie PAS la shape : d'apres son
        // en-tete OCCT, il « nettoie le modele de donnees temporaire quand
        // l'algorithme a fini ». Une face deja maillee PLUS FIN que demande est
        // jugee coherente et gardee telle quelle (BRepMesh_Deflection::IsConsistent).
        // Consequence mesuree (OCCT 8.0.1) : remailler a 0,5 un tore deja maille
        // a 0,01 rend 8 346 triangles — exactement les memes. La passe de budget
        // ne reduisait donc rien. Elle seule passe allowDecrease : 1 352 triangles,
        // identique a un maillage a froid. La cascade garde le defaut : les faces
        // qu'une tentative annulee a deja finies sont reutilisees, c'est du travail
        // gagne.
        mp.AllowQualityDecrease = allowDecrease;
        // [17/09] COPIE de la shape, pas une reference. TopoDS_Shape est un
        // handle leger : la copier coute quelques octets et garde le TShape
        // vivant. Avec la reference, un thread detache survivant a la sortie de
        // tessellateShape lisait `workPart`, une variable LOCALE du job de la
        // boucle parallele — use-after-free silencieux. Le defaut preexistait ;
        // il ne pouvait se manifester que sur le chemin qui detache, c'est-a-dire
        // exactement celui que le Scania vient d'emprunter quatre fois.
        TopoDS_Shape shCopy = shape;
        std::packaged_task<void()> task([shCopy, mp, prog]() {
            BRepMesh_IncrementalMesh mesher(shCopy, mp, prog->Start());
        });
        std::future<void> fut = task.get_future();
        std::thread worker(std::move(task));
        const auto budget = std::chrono::microseconds((long long)(sec * TESS_GRACE * 1e6));
        if (fut.wait_for(budget) == std::future_status::timeout) {
            worker.detach();   // annulation ignoree : cas rare, et desormais terminal
            gDetachedCount++;  // ce thread ne mourra jamais — cf. le bilan de fin d'import
            zombie = true;
            return false;
        }
        worker.join();
        return !prog->Broke();
    };

    if (!meshOnce(d, TESSELLATE_TIMEOUT_SEC)) {
        // [FIX 16/09 — Nass] Le repli etait SYNCHRONE ET SANS FILET : si la piece
        // resistait aussi a la deflexion grossiere, l'import se figeait ici pour
        // toujours. Constate sur Scania-8x4.stp, corps de ~22 mm : le [WARN]
        // s'affichait puis plus rien.
        //
        // Ce piege preexistait, mais il ne se declenchait jamais : avec la
        // deflexion unique de l'assemblage cette piece recevait 6,5 mm et passait
        // sans effort. La deflexion par corps lui donne 0,0325 mm — 200 fois plus
        // fin — et la fait basculer dans le regime pathologique. Le changement n'a
        // pas cree le piege, il a rendu sa rencontre probable : c'est donc a cette
        // fonction de le refermer.
        //
        // Desormais le repli est une CASCADE, chaque etage sous son propre delai,
        // et l'echec final abandonne le corps au lieu de bloquer l'import. Un corps
        // manquant sur 1451 se voit et se diagnostique ; un import fige, non.
        //
        // [17/09] La cascade est BORNEE. Elle valait d x20 / x200 / x2000 et
        // ignorait `deflectionCap`, alors que le garde-fou de budget, trente
        // lignes plus bas, le respecte scrupuleusement (« jamais au-dela de la
        // deflexion de reference — donc jamais pire qu'avant »). Deux garde-fous
        // dans la meme fonction, un borne, un non borne. Desormais : trois
        // paliers GEOMETRIQUES de d vers un plafond, dont le dernier vaut
        // exactement ce plafond. Le plafond, c'est la deflexion de la racine,
        // elle-meme bornee par la taille REELLE du corps (DEFL_CEIL_REL).
        // vertexBoxMetrics parcourt tous les sommets : on ne le paie que sur ce
        // chemin-ci, rare par construction.
        // Le plafond retient le plus PERMISSIF de trois reperes, chacun ayant sa
        // raison d'etre : la deflexion de la racine (le reglage d'avant la
        // deflexion par corps, dont on sait qu'il passait sur ce fichier), la
        // deflexion du corps elle-meme (jamais reculer), et DEFL_CEIL_REL de sa
        // taille reelle. Prendre le MINIMUM aurait condamne d'entree les corps
        // que bodyDeflection a deja plafonnes a dRef : pour eux d ==
        // cap, aucune marge, abandon immediat — alors qu'un x20 les sauvait.
        double _avgIgn = 0.0, L = 0.0;
        vertexBoxMetrics(shape, _avgIgn, L);
        double dCeil = (deflectionCap > d) ? deflectionCap : d;
        if (L > Precision::Confusion() && L * DEFL_CEIL_REL > dCeil)
            dCeil = L * DEFL_CEIL_REL;

        if (zombie || !(dCeil > d * 1.05)) {
            // Soit BRepMesh n'a pas honore l'annulation — retoucher cette shape
            // mettrait deux mesheurs dessus, ce qu'on ne fait plus jamais ; soit
            // le plafond ne laisse aucune marge utile. Dans les deux cas,
            // insister coute 25 s de mur pour un resultat deja connu.
            gAbandonedCount++;
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            std::ostringstream oss;
            oss << "[WARN] Body \"" << bodyName.substr(0, 40) << "\" abandoned at once: "
                << (zombie ? "mesher did not honour cancellation (thread detached)"
                           : "no room above the deflection ceiling")
                << " - d=" << d << " mm, ceiling=" << dCeil << " mm"
                << (L > Precision::Confusion() ? (" , body size=" + std::to_string(L) + " mm") : "")
                << ". Import continues without it.\n";
            std::cerr << oss.str();
            return zombie ? TessOutcome::Zombie : TessOutcome::Failed;
        }

        const double ratio  = std::pow(dCeil / d, 1.0 / (double)TESS_RETRIES);
        const double kSecs[] = { 10.0, 10.0, 5.0 };
        double dd = d;
        for (int i = 0; i < TESS_RETRIES; ++i) {
            dd = (i == TESS_RETRIES - 1) ? dCeil : dd * ratio;  // dernier barreau = plafond exact
            {
                std::lock_guard<std::mutex> lk(gConsoleMutex); // [15/08] atteignable depuis un thread de tessellation parallèle
                std::ostringstream oss;
                oss << "[WARN] Tessellation timeout on \"" << bodyName.substr(0, 40)
                    << "\" - retry " << (i + 1) << "/" << TESS_RETRIES << " at " << dd
                    << " mm (was " << d << ", ceiling " << dCeil << ").\n";
                std::cerr << oss.str();
            }
            if (meshOnce(dd, kSecs[i])) { finalDefl = dd; return TessOutcome::Done; }
            if (zombie) break;   // plus aucune tentative sur une shape occupee
        }
        gAbandonedCount++;
        {
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            std::ostringstream oss;
            oss << "[WARN] Body \"" << bodyName.substr(0, 40) << "\" abandoned: no triangulation "
                << "within the time budget, even at " << dCeil << " mm"
                << (zombie ? " (cancellation not honoured on the last try)" : "")
                << ". Import continues without it.\n";
            std::cerr << oss.str();
        }
        return zombie ? TessOutcome::Zombie : TessOutcome::Failed;
    }

    // Garde-fou de budget — jamais actif en mode « déflection forcée » (A/B).
    if (gDeflectionOverride > 0 || gTriBudgetPerBody <= 0) return TessOutcome::Done;
    const double cap = (deflectionCap > d) ? deflectionCap : d;
    for (int pass = 0; pass < 2; ++pass) {
        const long long n = countTriangles(shape);
        if (n <= gTriBudgetPerBody) break;
        double d2 = d * std::sqrt((double)n / (double)gTriBudgetPerBody);
        if (d2 > cap) d2 = cap;
        if (d2 <= d * 1.05) break;            // plus rien à gagner : on garde ce maillage
        {
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            std::ostringstream oss;
            oss << "  BUDGET       " << n << " triangles > " << gTriBudgetPerBody
                << " - deflection " << d << " -> " << d2 << " mm\n";
            logFileOnly(oss.str());
        }
        // [FIX 16/09] meme filet ici : ce second maillage doit lui aussi pouvoir
        // rendre la main. En cas d'echec on garde simplement le maillage precedent,
        // qui est deja valide — seulement plus lourd que le budget.
        if (!meshOnce(d2, (double)TESSELLATE_TIMEOUT_SEC, /*allowDecrease=*/true)) {
            {
                std::lock_guard<std::mutex> lk(gConsoleMutex);
                logFileOnly("  BUDGET       [timeout] \"" + bodyName.substr(0, 40)
                            + "\" - keeping the finer mesh"
                            + (zombie ? " (cancellation not honoured)" : "") + "\n");
            }
            if (zombie) return TessOutcome::Zombie;   // [17/09] la shape est occupee
            // [FIX 17/09 soir] allowDecrease a pu retirer l'ancien maillage de
            // certaines faces avant l'annulation. « Garder le maillage fin »
            // suppose qu'il est encore la : on le verifie, et on le refait a d
            // (qui vient de reussir) s'il manque.
            if (!allFacesTriangulated(shape) && !meshOnce(d, (double)TESSELLATE_TIMEOUT_SEC))
                return zombie ? TessOutcome::Zombie : TessOutcome::Failed;
            finalDefl = d;
            return TessOutcome::Done;
        }
        d = d2;
        finalDefl = d;
    }
    return TessOutcome::Done;
}

// ═══════════════════════════════════════════════════════════════════════════
// [FIX 17/09 soir — Nass] MEMOIRE PAR TShape, le temps d'un import.
//
// Log Scania du 17/09, 11:44:08 : « OverHearts3 » abandonne TROIS fois de
// suite, d=1e-06 a chaque fois. Les instances d'un meme prototype partagent
// leur TShape ; `zombie` ne vivait que dans l'appel en cours. Le verrou par
// TShape sortait avec lui, l'instance suivante le prenait, relancait un
// mesheur sur la MEME forme — ou un premier tournait encore — attendait 90 s,
// detachait a son tour. « Plus jamais deux mesheurs dessus » n'etait vrai que
// pour une instance.
//
// Desormais l'issue de chaque TShape est retenue :
//   - Zombie ou Failed : les autres instances sont ecartees sur-le-champ, sans
//     rien relancer, et sans extraction (un mesheur detache peut encore
//     ecrire la triangulation qu'on lirait).
//   - Done : les autres instances ne rappellent PAS BRepMesh. Le prototype
//     est deja maille (cf. tessellateShapeImpl, qui maille sans location) ;
//     extractInto relit sa triangulation avec la location de l'instance.
//     Rappeler BRepMesh sur une instance placee ailleurs est precisement ce
//     qui figeait « Spring ». Gain annexe : les vis repetees cent fois ne
//     coutent plus cent passages dans BRepMesh.
// L'appelant tient deja le verrou du TShape : lecture-decision-ecriture sont
// donc sequentielles pour une meme forme. gTessMemoMx ne protege que la table.
// Remise a zero a chaque import (tessMemoReset, cf. processStepBuffer) ; un
// TShape empoisonne reste vivant tant que son mesheur tourne (le thread en
// tient une copie), son adresse ne peut donc pas etre recyclee entre-temps.
// ═══════════════════════════════════════════════════════════════════════════
struct TessMemoEntry { TessOutcome outcome; double defl; };
static std::mutex gTessMemoMx;
static std::unordered_map<const void*, TessMemoEntry> gTessMemo;

static void tessMemoReset() {
    std::lock_guard<std::mutex> lk(gTessMemoMx);
    gTessMemo.clear();
}

// Renvoie false si le corps ne doit PAS etre extrait (abandonne, ou mesheur
// detache encore actif sur sa forme).
static bool tessellateShape(const TopoDS_Shape& shape, double deflection, double deflectionCap,
                            const std::string& bodyName) {
    const void* key = shape.TShape().get();
    bool known = false;
    TessMemoEntry prev{TessOutcome::Done, 0.0};
    {
        std::lock_guard<std::mutex> lk(gTessMemoMx);
        auto it = gTessMemo.find(key);
        if (it != gTessMemo.end()) { known = true; prev = it->second; }
    }
    if (known && prev.outcome != TessOutcome::Done) {
        gAbandonedCount++;
        std::lock_guard<std::mutex> lk(gConsoleMutex);
        std::ostringstream oss;
        oss << "[WARN] Body \"" << bodyName.substr(0, 40) << "\" skipped: same geometry as a body "
            << (prev.outcome == TessOutcome::Zombie ? "whose mesher is still running"
                                                    : "that could not be tessellated")
            << ". Import continues without it.\n";
        std::cerr << oss.str();
        return false;
    }
    if (known) return true;   // prototype deja maille : rien a refaire, cf. plus haut

    double finalDefl = deflection;
    const TessOutcome r = tessellateShapeImpl(shape, deflection, deflectionCap, bodyName, finalDefl);
    {
        std::lock_guard<std::mutex> lk(gTessMemoMx);
        gTessMemo[key] = TessMemoEntry{r, finalDefl};
    }
    return r == TessOutcome::Done;
}

// [24/09] Un mesheur detache (zombie) ecrit-il encore dans cette forme ?
static bool tessIsZombie(const TopoDS_Shape& shape) {
    std::lock_guard<std::mutex> lk(gTessMemoMx);
    auto it = gTessMemo.find(shape.TShape().get());
    return it != gTessMemo.end() && it->second.outcome == TessOutcome::Zombie;
}

// [PERF 18/08] reserve() par face + comptage de faces fusionne dans l'unique
// passage TopExp_Explorer(FACE) qui existait deja ici. Deux gains independants :
//  (1) reserve(taille_actuelle + nbNodes*3 / nbTris*3) AVANT de remplir CETTE
//      face — sans ca, positions/indices grandissent par la croissance geometrique
//      par defaut de std::vector, ce qui, pour une piece a plusieurs grosses faces
//      (NURBS finement tessellee), declenche plusieurs reallocations + recopies en
//      cascade au lieu de zero ; reserve() ne coute rien quand la capacite suffit
//      deja (juste une comparaison), donc aucun cout ajoute dans le cas normal.
//  (2) la fonction retourne desormais le nombre de faces topologiques rencontrees
//      (meme TopAbs_FACE, meme shape, meme ordre que l'ancienne boucle de comptage
//      separee qu'appelaient les deux sites d'appel juste apres, dans
//      processStepBuffer) — les deux appelants n'ont donc plus besoin de
//      reparcourir toute la topologie de la piece une seconde fois rien que pour
//      compter ses faces ; meme valeur obtenue, une seule traversee au lieu de deux.
// ─────────────────────────────────────────────────────────────────────────
// [26/08] occtColorToSRGB — SEUL point de sortie d'une Quantity_Color vers le
// reste du pipeline (NSTP, log [COLOR], --decode-colors). Ne jamais rappeler
// Red()/Green()/Blue() directement ailleurs dans ce fichier.
//
// Depuis OCCT 7.5, Quantity_Color stocke ses composantes en RGB LINEAIRE, et
// STEPCAFControl_Reader convertit les COLOUR_RGB du fichier (interpretes en
// sRGB) vers ce lineaire pendant Transfer(). Red()/Green()/Blue() rendent donc
// du lineaire, PAS les valeurs ecrites dans le fichier.
//
// Verifie empiriquement (OCCT 7.7, aller-retour STEP complet) :
//   fichier   COLOUR_RGB('',1.,0.4,0.)                    -> #FF6600
//   .Red()    (1.000000, 0.132868, 0.000000)              -> #FF2200   FAUX
//   Values()  (1.000000, 0.400000, 0.000000) TOC_sRGB     -> #FF6600   JUSTE
// Ecart mesure a l'affichage : -27% a -91% de luminance selon la teinte, parce
// que Three.js traite ce qu'il recoit comme du sRGB (r128 : pas de
// ColorManagement, outputEncoding = LinearEncoding — meme comportement naif
// que Coin3D cote FreeCAD). Le moteur de rendu n'est pas en cause : c'est bien
// l'accesseur utilise ici qui l'etait.
//
// Meme choix que FreeCAD, qui declare explicitement
// Mod/Import/App/ImportOCAF2.cpp : #define OCC_COLOR_SPACE Quantity_TOC_sRGB.
// L'alignement se fait donc d'un coup sur FreeCAD, Fusion et CAD Assistant.
//
// NE PAS remplacer par un gamma maison (pow 1/2.2) : la courbe sRGB a un
// segment lineaire sous 0.0031308, une approximation gamma decale les tons
// sombres — precisement la zone ou l'ecart etait le plus visible.
static void occtColorToSRGB(const Quantity_Color& c, double& r, double& g, double& b) {
    c.Values(r, g, b, Quantity_TOC_sRGB);
}

static int extractIntoLegacy(const TopoDS_Shape& shape, const std::string& name,
                            std::optional<Quantity_Color> color,
                            std::vector<MeshData>& out,
                            const FaceColorMap* faceColors = nullptr,
                            float alpha = 1.0f) {
    MeshData md;
    md.name = name;
    if (color) {
        // [26/08] sRGB et non Red()/Green()/Blue() (lineaire) — cf. occtColorToSRGB.
        double sr, sg, sb;
        occtColorToSRGB(*color, sr, sg, sb);
        md.hasColor = true; md.r = (float)sr; md.g = (float)sg; md.b = (float)sb;
        md.a = alpha;
    }

    // [27/08] Une "plage" = les index produits par UNE face, avec sa couleur.
    // Enregistrees dans l'ordre des faces, puis regroupees par couleur en fin de
    // fonction. Rien n'est alloue quand faceColors est nul (solide monochrome).
    struct Run { uint32_t key; float r, g, b; uint32_t start, count; float a; };
    std::vector<Run> runs;
    // [18/09] L'opacite entre dans la cle : deux faces de meme teinte dont l'une
    // est transparente sont deux groupes, pas un seul.
    auto colorKey = [](float r, float g, float b, float a) -> uint32_t {
        // Quantification 8 bits : c'est de toute facon la precision d'affichage,
        // et ca evite de creer deux groupes pour deux flottants qui ne different
        // qu'au-dela du millieme.
        return ((uint32_t)std::lround(a * 255.0f) << 24)
             | ((uint32_t)std::lround(r * 255.0f) << 16)
             | ((uint32_t)std::lround(g * 255.0f) << 8)
             |  (uint32_t)std::lround(b * 255.0f);
    };

    uint32_t vertexOffset = 0;
    int faceCount = 0;
    for (TopExp_Explorer faceExp(shape, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
        faceCount++;
        TopoDS_Face face = TopoDS::Face(faceExp.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;

        const gp_Trsf& trsf = loc.Transformation();
        Standard_Integer nbNodes = tri->NbNodes();
        Standard_Integer nbTris = tri->NbTriangles();
        md.positions.reserve(md.positions.size() + (size_t)nbNodes * 3);
        md.indices.reserve(md.indices.size() + (size_t)nbTris * 3);
        for (Standard_Integer i = 1; i <= nbNodes; i++) {
            gp_Pnt p = tri->Node(i);
            p.Transform(trsf);
            md.positions.push_back((float)p.X());
            md.positions.push_back((float)p.Y());
            md.positions.push_back((float)p.Z());
        }
        bool reversed = (face.Orientation() == TopAbs_REVERSED);
        const uint32_t runStart = (uint32_t)md.indices.size();
        for (Standard_Integer i = 1; i <= nbTris; i++) {
            Standard_Integer n1, n2, n3;
            tri->Triangle(i).Get(n1, n2, n3);
            if (reversed) std::swap(n2, n3);
            md.indices.push_back(vertexOffset + n1 - 1);
            md.indices.push_back(vertexOffset + n2 - 1);
            md.indices.push_back(vertexOffset + n3 - 1);
        }
        vertexOffset += (uint32_t)nbNodes;

        if (faceColors) {
            // Couleur de CETTE face si le fichier en pose une, sinon celle du
            // solide — une face non stylee dans un solide multicolore rejoint
            // naturellement le groupe de la couleur dominante.
            float fr = md.r, fg = md.g, fb = md.b, fa = md.a;
            auto it = faceColors->find(faceExp.Current().TShape().get());
            if (it != faceColors->end()) { fr = it->second.r; fg = it->second.g; fb = it->second.b; fa = it->second.a; }
            const uint32_t cnt = (uint32_t)md.indices.size() - runStart;
            if (cnt) runs.push_back(Run{ colorKey(fr, fg, fb, fa), fr, fg, fb, runStart, cnt, fa });
        }
    }

    // [27/08] Les plages sont deja dans l'ordre des faces : AUCUN reordonnancement
    // du buffer d'index. C'est la difference avec un regroupement par couleur, et
    // c'est ce qui preserve l'identite des faces jusqu'au client — plus une
    // propriete precieuse : l'ordre des triangles sortant d'OCCT reste intact, donc
    // weldMeshLocal (remap de sommets) et smoothMeshBFSLocal (out.idx[f*3+vi], face
    // par face) le preservent aussi. Seule l'union Manifold le detruirait, et le
    // client la saute pour les corps porteurs de couleurs par face.
    //
    // Le tableau n'est rempli que s'il y a au moins DEUX couleurs distinctes :
    // un solide monochrome garde son unique champ "color", exactement comme
    // FreeCAD reduit DiffuseColor a une seule entree dans ce cas.
    if (runs.size() > 1) {
        bool multi = false;
        for (size_t i = 1; i < runs.size() && !multi; i++)
            if (runs[i].key != runs[0].key) multi = true;
        if (multi) {
            md.faces.reserve(runs.size());
            for (const Run& rn : runs)
                md.faces.push_back(MeshData::FaceRange{ rn.r, rn.g, rn.b, rn.start, rn.count, rn.a });
        }
    }

    if (!md.positions.empty() && !md.indices.empty()) out.push_back(std::move(md));
    return faceCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// [21/09 — Nass] COUTURE PAR TOPOLOGIE — « ne pas reparer, ne pas fabriquer »
// ═══════════════════════════════════════════════════════════════════════════
//
// CONSTAT QUI JUSTIFIE CE BLOC
// ----------------------------
// Sur Scania-Engine-V8-XT-Turbo.step, step-declare annonce : 254 solides,
// 267 coques FERMEES, 0 ouverte, 100,00 % des aretes partagees par exactement
// 2 faces. Le B-Rep source est donc topologiquement sain. Et pourtant ~19 %
// des corps ressortent non manifold du pipeline (13/13 DIN 912-M16x80,
// 13/13 M12x45, 4/4 V8-XT-35A... pendant que 10/10 M22x150 et 12/12 M10x30
// sont watertight). Ce n'est pas le fichier : c'est NOUS qui fabriquons le
// defaut, entre la triangulation OCCT et la soudure.
//
// Le coupable est extractIntoLegacy : il empile les noeuds de CHAQUE face avec
// un `vertexOffset`, donc deux faces adjacentes ne partagent AUCUN sommet. Le
// maillage qui sort d'OCCT est une soupe par face — toute arete interieure y
// est nue — et c'est une soudure PAR PROXIMITE (weldMeshLocal, puis la cascade
// adaptative de step-import.js) qui doit ensuite deviner quels sommets n'en
// font qu'un. Cette soudure a deux facons de se tromper, et elle les cumule :
//   - trop fine : elle laisse des sommets dupliques -> fissures -> aretes nues.
//     C'est la NOTE que weldMeshLocal porte deja : a 1400 mm en float32, le pas
//     du float (~1,2e-4) DEPASSE tol=1e-4, donc deux sommets qu'OCCT a calcules
//     identiques en double deviennent deux floats distincts que la soudure
//     refuse de fusionner.
//   - trop grossiere : elle fusionne deux sommets distincts mais proches
//     -> arete a 4 triangles -> non manifold, et cette fois c'est irreparable
//     sans defaire la fusion.
// Aucun epsilon ne satisfait les deux en meme temps. C'est un probleme mal
// pose, pas un probleme mal regle.
//
// CE QU'ON FAIT A LA PLACE
// ------------------------
// On ne devine plus : on demande a OCCT. BRepMesh discretise chaque arete UNE
// FOIS et range le resultat sur la TEdge (Poly_PolygonOnTriangulation), une
// representation par triangulation de face qui s'appuie dessus. Les deux faces
// adjacentes voient donc la MEME polyligne, indexee dans leurs triangulations
// respectives : on tient une correspondance de sommets EXACTE, a l'indice pres,
// sans tolerance, sans hash, sans arbitrage. C'est la discipline standard du
// maillage conforme de B-Rep (mailler la topologie, pas les faces) et la seule
// qui rende le probleme bien pose.
//
// Trois etages, dans cet ordre — c'est une echelle graduee, pas un marteau :
//
//   A. COUTURE EXACTE PAR TOPOLOGIE (sans tolerance).
//      Pour chaque arete du prototype on rassemble ses USAGES (face, polygone).
//      Une arete saine en a exactement 2 : soit deux faces voisines, soit UNE
//      face deux fois (couture de surface periodique — le seam d'un cylindre).
//      Les deux cas se traitent pareil, ce qui regle le seam gratuitement.
//      Les aretes degenerees (apex de cone, pole de sphere, BRep_Tool::
//      Degenerated) effondrent tous leurs noeuds sur UN sommet : c'est ce qui
//      transforme un eventail de doublons en un vrai point singulier.
//
//   B. COUTURE RESIDUELLE, GEOMETRIQUE, RESTREINTE AUX BORDS (tolerance bornee).
//      Ce qui reste nu apres A est apparie ARETE A ARETE, jamais sommet a
//      sommet, avec une tolerance RELATIVE a la diagonale de la piece et
//      PROGRESSIVE (1e-9, 1e-7, 1e-5 de la diagonale) — Barequet & Kumar 1997
//      pour l'appariement de bords sous tolerance, Borodin & al. 2002 pour la
//      tolerance progressive plutot qu'un epsilon global. Deux garde-fous :
//      on ne touche QUE des aretes de bord (jamais un sommet interieur, donc
//      jamais de papillon fabrique), et toute passe qui ferait apparaitre une
//      arete a plus de 2 triangles est ANNULEE en bloc (snapshot/rollback du
//      union-find). On travaille en double dans le repere du prototype : la
//      perte float32 n'a pas encore eu lieu, donc la tolerance peut etre
//      serree pour de vrai.
//
//   C. NETTOYAGE SANS PERTE.
//      Triangles degeneres (deux indices egaux — ce que produit justement
//      l'effondrement d'un apex) et triangles STRICTEMENT dupliques (meme
//      cycle, meme orientation). Les triangles opposes deux a deux sont
//      seulement COMPTES, jamais supprimes : ils peuvent etre une geometrie
//      d'epaisseur nulle legitime, ce n'est pas a nous d'en decider.
//
// Puis on MESURE : aretes nues, aretes sur-valencees, et sommets papillon —
// ce dernier test manquait, et c'est pourtant un cas que Manifold refuse
// (toutes les aretes a 2 triangles ne suffisent PAS : deux cones qui se
// touchent par la pointe passent ce test et ne sont pas une variete).
//
// PROPRIETE DE SURETE
// -------------------
// Si OCCT n'a range aucun polygone d'arete, l'etage A ne coud rien et on
// retombe exactement sur la soupe par face de l'ancien chemin, que
// step-import.js sait deja souder. Le pire cas de ce bloc est donc le statu
// quo, jamais une regression. Toute exception est rattrapee et renvoie le
// corps a extractIntoLegacy.
//
// NASSCAD_TOPOWELD=0 rebascule sur extractIntoLegacy sans recompiler.
// ═══════════════════════════════════════════════════════════════════════════

// Compteurs agreges par requete (remis a zero dans processStepBuffer, publies
// dans gMetaJson pour que le client recoive une etiquette venue de la source).
static std::atomic<int>       gWeldBodies{0};         // corps passes par la couture
static std::atomic<int>       gWeldWatertight{0};     // ... dont watertight en sortie
static std::atomic<long long> gWeldEdgesTopo{0};      // aretes cousues sans tolerance
static std::atomic<long long> gWeldEdgesResidual{0};  // aretes cousues par l'etage B
static std::atomic<long long> gWeldEdgesMismatch{0};  // discretisations incoherentes
static std::atomic<long long> gWeldTrisDropped{0};    // degeneres + dupliques
static std::atomic<int>       gWeldFallback{0};       // corps repasses en legacy
static std::atomic<long long> gWeldFacesFilled{0};    // [FIX 27/09] faces refaites par l'etage A'
static std::atomic<long long> gWeldDiagFlips{0};      // [FIX 27/09] diagonales basculees (etage C)

// [21/09] L'etiquette, en un seul endroit : /step la met dans gMetaJson,
// /stepstream dans sa frame terminale. Deux chemins, un seul texte — c'est
// justement ce qui manquait, l'import de production passe par /stepstream et
// n'aurait rien vu d'une etiquette posee uniquement dans encodeNSTP.
static std::string weldMetaJson();

static bool topoWeldEnabled() {
    // Lecture unique, initialisation thread-safe (C++11).
    static const bool on = [] {
        const char* e = std::getenv("NASSCAD_TOPOWELD");
        return !(e && e[0] == '0');
    }();
    return on;
}

static std::string weldMetaJson() {
    std::ostringstream o;
    o << "\"weld\":{"
      <<   "\"bodies\":"         << gWeldBodies.load()        << ","
      <<   "\"watertight\":"     << gWeldWatertight.load()    << ","
      <<   "\"stillBroken\":"    << (gWeldBodies.load() - gWeldWatertight.load()) << ","
      <<   "\"edgesTopo\":"      << gWeldEdgesTopo.load()     << ","
      <<   "\"edgesResidual\":"  << gWeldEdgesResidual.load() << ","
      <<   "\"edgesMismatch\":"  << gWeldEdgesMismatch.load() << ","
      <<   "\"trisDropped\":"    << gWeldTrisDropped.load()   << ","
      <<   "\"legacyFallback\":" << gWeldFallback.load()      << ","
      <<   "\"facesFilled\":"    << gWeldFacesFilled.load()   << ","
      <<   "\"diagonalFlips\":"  << gWeldDiagFlips.load()     << ","
      <<   "\"enabled\":"        << (topoWeldEnabled() ? "true" : "false")
      << "}";
    return o.str();
}

namespace nasweld {

// Diagnostic d'UN corps. C'est l'« etiquette » : pas un booleen, un releve.
struct Diag {
    uint32_t nodesIn   = 0;   // somme des NbNodes() des faces (avant couture)
    uint32_t vertsOut  = 0;   // sommets apres couture
    int  edgesTopo     = 0;   // etage A : aretes cousues exactement
    int  edgesDegen    = 0;   // etage A : aretes degenerees effondrees
    int  edgesMismatch = 0;   // etage A : 2 usages, nombres de noeuds differents
    int  edgesOverUsed = 0;   // etage A : > 2 usages — non manifold DANS le B-Rep
    int  edgesSeamOnly = 0;   // etage A : un seul polygone expose, seam laisse a B
    int  edgesNmPaired = 0;   // etage A : aretes non manifold du B-Rep, usages apparies 2 a 2
    int  facesFilled   = 0;   // etage A' : faces sans triangulation, remplies depuis leur bord
    int  facesRedone   = 0;   // etage A' : triangulations OCCT incoherentes avec leurs aretes, refaites
    int  facesCollapsed= 0;   // etage A' : lamelles dont le contour tient en deux noeuds (rien a emettre)
    int  facesUnfilled = 0;   // etage A' : faces qu'aucun repli n'a su trianguler
    int  edgesResidual = 0;   // etage B : aretes de bord appariees
    int  edgesFlipped  = 0;   // etage B : appariees en MEME sens (orientation suspecte)
    double residualTol = 0.0; // tolerance qui a suffi a l'etage B (0 = inutile)
    int  trisDegen     = 0;   // etage C : supprimes
    int  trisDup       = 0;   // etage C : supprimes
    int  trisOpposed   = 0;   // etage C : comptes, JAMAIS supprimes
    int  diagFlips     = 0;   // etage C : diagonales basculees (arete a 4 triangles, deux faces)
    int  microCollapsed= 0;   // etage C : micro-aretes (< 2 um) contractees sous condition de lien
    int  microClusters = 0;   // etage C : amas de sommets distincts a moins de 2 um, fusionnes
    int  trisCancelled = 0;   // etage C : triangles opposes NES de cette fusion, annules par paires
    int  shortCollapsed= 0;   // etage C : aretes a plus de 2 triangles, sous la deflexion, contractees
    int  nakedEdges    = 0;   // etat FINAL
    int  overValenced  = 0;
    int  bowtieVerts   = 0;
    bool watertight() const {
        return nakedEdges == 0 && overValenced == 0 && bowtieVerts == 0;
    }
    std::string brief() const {
        std::ostringstream o;
        o << "verts " << nodesIn << "->" << vertsOut << ", topo " << edgesTopo;
        if (edgesDegen)    o << ", degen " << edgesDegen;
        if (edgesSeamOnly) o << ", seam-deferred " << edgesSeamOnly;
        if (edgesMismatch) o << ", mismatch " << edgesMismatch;
        if (edgesOverUsed) o << ", brep-overused " << edgesOverUsed;
        if (edgesNmPaired) o << ", brep-nonmanifold-paired " << edgesNmPaired;
        if (facesFilled)   o << ", faces-filled " << facesFilled;
        if (facesRedone)   o << ", faces-retriangulated " << facesRedone;
        if (facesCollapsed)o << ", faces-collapsed " << facesCollapsed;
        if (facesUnfilled) o << ", faces-unfilled " << facesUnfilled;
        if (edgesResidual) o << ", residual " << edgesResidual << " @tol " << residualTol;
        if (edgesFlipped)  o << ", same-dir " << edgesFlipped;
        if (trisDegen)     o << ", -degen-tri " << trisDegen;
        if (trisDup)       o << ", -dup-tri " << trisDup;
        if (trisOpposed)   o << ", opposed-tri " << trisOpposed;
        if (diagFlips)     o << ", diagonal-flips " << diagFlips;
        if (microCollapsed)o << ", micro-edges-collapsed " << microCollapsed;
        if (microClusters) o << ", micro-clusters " << microClusters;
        if (trisCancelled) o << ", -cancelled-tri " << trisCancelled;
        if (shortCollapsed)o << ", short-edges-collapsed " << shortCollapsed;
        if (watertight())  o << " => WATERTIGHT";
        else o << " => naked " << nakedEdges << ", over-valenced " << overValenced
               << ", bowtie " << bowtieVerts;
        return o.str();
    }
};

// Union-find, compression de chemin. Pas d'union par rang : on veut pouvoir
// restaurer l'etat exact (snapshot du tableau parent) pour annuler une passe
// residuelle refusee, et le rang complique ca pour rien a cette taille.
class DSU {
public:
    explicit DSU(size_t n) : p_(n) { for (size_t i = 0; i < n; ++i) p_[i] = (uint32_t)i; }
    uint32_t find(uint32_t x) {
        while (p_[x] != x) { p_[x] = p_[p_[x]]; x = p_[x]; }
        return x;
    }
    bool unite(uint32_t a, uint32_t b) {
        a = find(a); b = find(b);
        if (a == b) return false;
        p_[b] = a; return true;
    }
    std::vector<uint32_t> snapshot() const { return p_; }
    void restore(const std::vector<uint32_t>& s) { p_ = s; }
    // [FIX 27/09] Un noeud de plus, seul dans sa classe — pour les sommets que
    // cree le remplissage des faces sans triangulation (cf. etage A').
    uint32_t add() { p_.push_back((uint32_t)p_.size()); return (uint32_t)(p_.size() - 1); }
private:
    std::vector<uint32_t> p_;
};

struct FaceSlot {
    TopoDS_Face face;
    Handle(Poly_Triangulation) tri;
    TopLoc_Location loc;      // location de la face DANS le prototype
    uint32_t off = 0;         // index global du premier noeud de la face
    int      nb  = 0;         // NbNodes() (0 = face non triangulee)
};

// [FIX 27/09] `rev` : sens de l'arete dans CETTE face, orientation de la face
// comprise — sert a apparier les usages d'une arete non manifold (cf. etage A).
struct EdgeUse { uint32_t slot; Handle(Poly_PolygonOnTriangulation) pol; bool rev = false; };

static inline uint64_t edgeKey(uint32_t a, uint32_t b) {
    if (a > b) { const uint32_t t = a; a = b; b = t; }
    return ((uint64_t)a << 32) | (uint64_t)b;
}

// Cle EXACTE de triangle (pas un hash : une collision supprimerait un triangle
// legitime). L'egalite porte sur les trois indices, le hash ne sert qu'au
// bucketing.
struct TriKey {
    uint32_t a, b, c;
    bool operator==(const TriKey& o) const { return a == o.a && b == o.b && c == o.c; }
};
struct TriKeyHash {
    size_t operator()(const TriKey& k) const {
        uint64_t h = (uint64_t)k.a * 0x9E3779B97F4A7C15ull;
        h ^= (uint64_t)k.b + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
        h ^= (uint64_t)k.c + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
        return (size_t)h;
    }
};

// Aretes nues / sur-valencees / sommets papillon d'une soupe indexee.
// Le test du papillon : pour chaque sommet, les triangles incidents doivent
// former UN seul eventail. On les relie deux a deux quand ils partagent une
// arete contenant ce sommet, et on compte les composantes.
static void analyzeTopology(const std::vector<uint32_t>& idx, uint32_t nVerts,
                            int& naked, int& over, int& bowtie) {
    naked = over = bowtie = 0;
    const size_t nTri = idx.size() / 3;
    if (!nTri || !nVerts) return;

    std::unordered_map<uint64_t, int> ec;
    ec.reserve(nTri * 3);
    for (size_t t = 0; t < nTri; ++t) {
        const uint32_t a = idx[t*3], b = idx[t*3+1], c = idx[t*3+2];
        ec[edgeKey(a,b)]++; ec[edgeKey(b,c)]++; ec[edgeKey(c,a)]++;
    }
    for (const auto& kv : ec) {
        if (kv.second == 1) naked++;
        else if (kv.second > 2) over++;
    }

    // Adjacence sommet -> triangles, en CSR (pas de vector<vector>).
    std::vector<uint32_t> start(nVerts + 1, 0);
    for (size_t t = 0; t < nTri; ++t)
        for (int k = 0; k < 3; ++k) start[idx[t*3+k] + 1]++;
    for (uint32_t v = 0; v < nVerts; ++v) start[v+1] += start[v];
    std::vector<uint32_t> triAtVert(start[nVerts]);
    {
        std::vector<uint32_t> cur(start.begin(), start.end() - 1);
        for (size_t t = 0; t < nTri; ++t)
            for (int k = 0; k < 3; ++k) triAtVert[cur[idx[t*3+k]]++] = (uint32_t)t;
    }

    // Cle = (sommet apex, autre extremite de l'arete). Deux triangles qui
    // partagent l'arete (apex, autre) appartiennent au meme eventail en apex.
    std::unordered_map<uint64_t, uint32_t> firstTriOfCorner;
    firstTriOfCorner.reserve(nTri * 6);
    DSU fan(nTri);
    for (size_t t = 0; t < nTri; ++t) {
        const uint32_t v[3] = { idx[t*3], idx[t*3+1], idx[t*3+2] };
        for (int k = 0; k < 3; ++k)
            for (int j = 1; j <= 2; ++j) {
                const uint64_t ck = ((uint64_t)v[k] << 32) | (uint64_t)v[(k + j) % 3];
                auto it = firstTriOfCorner.find(ck);
                if (it == firstTriOfCorner.end()) firstTriOfCorner.emplace(ck, (uint32_t)t);
                else fan.unite(it->second, (uint32_t)t);
            }
    }
    for (uint32_t v = 0; v < nVerts; ++v) {
        const uint32_t a = start[v], b = start[v+1];
        if (b - a < 2) continue;
        const uint32_t root = fan.find(triAtVert[a]);
        for (uint32_t i = a + 1; i < b; ++i)
            if (fan.find(triAtVert[i]) != root) { bowtie++; break; }
    }
}

} // namespace nasweld

// [FIX 27/09] Decoupe d'oreilles avec pontage des trous, sur des points 2D.
// Definie apres nasifc::tri (plus bas dans le fichier), dont elle reutilise
// earClip et bridgeHoles. `outer` et `holes` indexent `pts` ; `tris` recoit des
// triplets d'indices dans `pts`, dans le sens direct du plan 2D. `forced` : voir
// la definition — un resultat topologiquement ferme meme sur un contour qui se
// croise.
static bool fillTriangulate2D(const std::vector<std::pair<double, double>>& pts,
                              std::vector<uint32_t> outer,
                              std::vector<std::vector<uint32_t>> holes,
                              std::vector<uint32_t>& tris,
                              bool forced,
                              const std::vector<uint32_t>* ident);

// Extraction AVEC couture par topologie. `usable` a false = rien d'exploitable
// ici (aucune face triangulee) : l'appelant retombe sur le chemin legacy.
static int extractIntoTopo(const TopoDS_Shape& shape, const std::string& name,
                           std::optional<Quantity_Color> color,
                           std::vector<MeshData>& out,
                           const FaceColorMap* faceColors,
                           float alpha,
                           bool& usable) {
    using namespace nasweld;
    usable = false;

    // Le prototype : la connectivite ne depend PAS du placement de l'instance,
    // et BRepMesh a range les polygones d'aretes avec la location qu'il avait au
    // maillage — celle du prototype (cf. tessellateShapeImpl, qui maille
    // `located.Located(TopLoc_Location())`). Les chercher avec la location
    // composee de l'instance ne trouverait rien : c'est exactement le piege que
    // decrit le commentaire du 17/09.
    const TopoDS_Shape    proto   = shape.Located(TopLoc_Location());
    const TopLoc_Location instLoc = shape.Location();

    // ── Recensement des faces, dans l'ordre exact de TopExp_Explorer : c'est
    // l'ordre dont dependent les plages de couleur par face, il ne bouge pas.
    std::vector<FaceSlot> slots;
    uint32_t nodesIn = 0;
    int faceCount = 0;
    for (TopExp_Explorer fe(proto, TopAbs_FACE); fe.More(); fe.Next()) {
        faceCount++;
        FaceSlot s;
        s.face = TopoDS::Face(fe.Current());
        s.tri  = BRep_Tool::Triangulation(s.face, s.loc);
        s.off  = nodesIn;
        s.nb   = s.tri.IsNull() ? 0 : (int)s.tri->NbNodes();
        nodesIn += (uint32_t)s.nb;
        slots.push_back(std::move(s));
    }
    if (!nodesIn) return faceCount;   // rien a extraire, et rien a rattraper
    usable = true;

    Diag diag;
    diag.nodesIn = nodesIn;

    // ── Positions de tous les noeuds, en DOUBLE, dans le repere du prototype.
    // Le cast float32 n'a lieu qu'a la toute fin : tant qu'on est ici, deux
    // noeuds qu'OCCT a calcules identiques LE SONT, et la couture geometrique
    // de l'etage B peut se permettre une tolerance serree.
    std::vector<double> pp((size_t)nodesIn * 3);
    for (const FaceSlot& s : slots) {
        if (!s.nb) continue;
        const gp_Trsf& tr = s.loc.Transformation();
        for (int i = 1; i <= s.nb; ++i) {
            gp_Pnt p = s.tri->Node(i);
            p.Transform(tr);
            const size_t g = ((size_t)s.off + (size_t)(i - 1)) * 3;
            pp[g] = p.X(); pp[g+1] = p.Y(); pp[g+2] = p.Z();
        }
    }
    double lo[3] = { pp[0], pp[1], pp[2] }, hi[3] = { pp[0], pp[1], pp[2] };
    for (uint32_t v = 0; v < nodesIn; ++v)
        for (int k = 0; k < 3; ++k) {
            const double c = pp[(size_t)v*3+k];
            if (c < lo[k]) lo[k] = c;
            if (c > hi[k]) hi[k] = c;
        }
    const double diagLen = std::sqrt((hi[0]-lo[0])*(hi[0]-lo[0])
                                   + (hi[1]-lo[1])*(hi[1]-lo[1])
                                   + (hi[2]-lo[2])*(hi[2]-lo[2]));

    // [FIX 27/09] Deflexion a laquelle CE corps a ete maille : celle que
    // tessellateShape a memorisee pour son TShape ; a defaut la plus grande des
    // triangulations, si elle est significative — une face plane rend une
    // deflexion de 1e-15, et OCCT refuse de discretiser sous 1e-7 ; a defaut
    // encore 0,1 % de la diagonale. Sert au remplissage (etage A') et au
    // plafond des contractions (etage C).
    double bodyDefl = 0.0;
    {
        std::lock_guard<std::mutex> lk(gTessMemoMx);
        auto it = gTessMemo.find(shape.TShape().get());
        if (it != gTessMemo.end() && it->second.outcome == TessOutcome::Done) bodyDefl = it->second.defl;
    }
    if (!(bodyDefl > 0.0)) {
        for (const FaceSlot& s : slots)
            if (s.nb && s.tri->Deflection() > bodyDefl) bodyDefl = s.tri->Deflection();
        if (!(bodyDefl > 1e-6 * diagLen) || !(bodyDefl > 1e-6)) bodyDefl = 1e-3 * diagLen;
        if (!(bodyDefl > 1e-6)) bodyDefl = 1e-3;
    }

    DSU dsu(nodesIn);

    // ═══ ETAGE A — couture exacte par topologie ═══════════════════════════
    // Usages de chaque arete. Une arete visitee deux fois par la MEME face
    // (seam) ne doit etre depouillee qu'une fois, sinon on enregistre ses
    // polygones en double : d'ou le garde `seenInFace`.
    std::unordered_map<const void*, std::vector<EdgeUse>> uses;
    std::unordered_map<const void*, TopoDS_Edge> edgeByKey;
    for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si) {
        const FaceSlot& s = slots[si];
        if (!s.nb) continue;
        std::unordered_set<const void*> seenInFace;
        for (TopExp_Explorer ee(s.face, TopAbs_EDGE); ee.More(); ee.Next()) {
            const TopoDS_Edge& e = TopoDS::Edge(ee.Current());
            const void* key = e.TShape().get();
            if (!seenInFace.insert(key).second) continue;
            edgeByKey.emplace(key, e);
            // Toutes les representations « polygone sur triangulation » de
            // l'arete ; on garde celles portees par la triangulation DE CETTE
            // FACE (le handle de triangulation est unique par TFace, donc cette
            // egalite suffit a identifier la face — inutile de comparer les
            // locations, qui different justement entre prototype et instance).
            //
            // [FIX 27/09] LES COUTURES N'ETAIENT JAMAIS COUSUES. L'ancien acces,
            // BRep_Tool::PolygonOnTriangulation(e, P, T, L, rang), ne rend que le
            // PREMIER polygone d'une representation fermee : la couture d'un
            // cylindre ou d'un tore (une arete bordee deux fois par la MEME face,
            // une fois a u=0, une fois a u=2pi) porte deux polygones, et le second
            // n'est expose que par PolygonOnTriangulation2(). Ajoute au garde
            // seenInFace, chaque couture ressortait avec UN seul usage : « bord
            // franc », rien de cousu, rien de compte — le releve n'annoncait meme
            // pas de « seam-deferred ». Tout reposait alors sur l'etage B, qui
            // annule sa passe en bloc des qu'elle fabrique une arete a trois
            // triangles. Mesure (OCCT 7.6.3, KR600_R2830-4.stp) : 51 coutures non
            // cousues sur le seul corps 0, 30 corps sur 61 non etanches en sortie
            // de MEDUSA. On lit donc directement la liste des representations de
            // la TEdge : les deux polygones d'une couture deviennent deux usages
            // de la meme face, et l'etage A les coud exactement, a l'indice pres,
            // comme n'importe quelle arete entre deux faces.
            const Handle(BRep_TEdge) te = Handle(BRep_TEdge)::DownCast(e.TShape());
            if (te.IsNull()) continue;
            const bool eRev = (e.Orientation() == TopAbs_REVERSED);
            for (const Handle(BRep_CurveRepresentation)& cr : te->Curves()) {
                if (cr.IsNull() || !cr->IsPolygonOnTriangulation()) continue;
                if (cr->Triangulation().get() != s.tri.get()) continue;
                const bool closed = cr->IsPolygonOnClosedTriangulation();
                // Couture : PolygonOnTriangulation() est le cote FORWARD, ...2() le cote REVERSED.
                if (!cr->PolygonOnTriangulation().IsNull())
                    uses[key].push_back(EdgeUse{ si, cr->PolygonOnTriangulation(), closed ? false : eRev });
                if (closed && !cr->PolygonOnTriangulation2().IsNull())
                    uses[key].push_back(EdgeUse{ si, cr->PolygonOnTriangulation2(), true });
            }
        }
    }

    auto nodeOf = [&](const EdgeUse& u, int i) -> uint32_t {
        return slots[u.slot].off + (uint32_t)u.pol->Node(i) - 1;
    };
    auto distG = [&](uint32_t a, uint32_t b) -> double {
        const double dx = pp[(size_t)a*3]   - pp[(size_t)b*3];
        const double dy = pp[(size_t)a*3+1] - pp[(size_t)b*3+1];
        const double dz = pp[(size_t)a*3+2] - pp[(size_t)b*3+2];
        return std::sqrt(dx*dx + dy*dy + dz*dz);
    };

    // [FIX 27/09] Noeuds des aretes que le B-Rep lui-meme fait porter par plus de
    // deux cotes de face : leur recouvrement est DECLARE, l'etage C ne les
    // fusionne jamais (cf. les amas sous le micron).
    std::vector<uint32_t> nmNodes;

    // Couture exacte de DEUX usages d'une meme arete. false = discretisations
    // incoherentes (nombres de noeuds differents) : l'etage B s'en chargera.
    auto sewPair = [&](const EdgeUse& a, const EdgeUse& b) -> bool {
        const int n0 = (int)a.pol->NbNodes(), n1 = (int)b.pol->NbNodes();
        if (n0 != n1 || n0 < 2) return false;
        // Les deux polylignes suivent la parametrisation de l'arete, donc le
        // meme ordre. On ne s'y fie pas : on verifie sur les extremites, en 3D.
        const double dDir = distG(nodeOf(a, 1), nodeOf(b, 1)) + distG(nodeOf(a, n0), nodeOf(b, n1));
        const double dRev = distG(nodeOf(a, 1), nodeOf(b, n1)) + distG(nodeOf(a, n0), nodeOf(b, 1));
        const bool rev = (dRev < dDir);
        for (int i = 1; i <= n0; ++i)
            dsu.unite(nodeOf(a, i), nodeOf(b, rev ? (n0 - i + 1) : i));
        return true;
    };

    for (auto& kv : uses) {
        std::vector<EdgeUse>& v = kv.second;
        const TopoDS_Edge& e = edgeByKey[kv.first];

        if (BRep_Tool::Degenerated(e)) {
            // Apex de cone, pole de sphere : la polyligne s'effondre sur UN
            // point 3D. Tous ses noeuds deviennent le meme sommet — c'est ce
            // qui change un eventail de doublons en point singulier propre.
            // Les triangles qui en heritent deux indices egaux sont degeneres
            // et tombent a l'etage C.
            uint32_t first = UINT32_MAX;
            for (const EdgeUse& u : v)
                for (int i = 1; i <= (int)u.pol->NbNodes(); ++i) {
                    const uint32_t g = nodeOf(u, i);
                    if (first == UINT32_MAX) first = g; else dsu.unite(first, g);
                }
            diag.edgesDegen++;
            continue;
        }
        if (v.size() > 2) {
            // Non manifold EN AMONT : le fichier lui-meme fait porter l'arete par
            // plus de deux cotes de face (RC_Buggy : 45 EDGE_CURVE referencees 4
            // fois, cf. step-declare.js). [FIX 27/09] On ne cousait RIEN : les
            // quatre polylignes restaient nues (244 aretes nues sur un seul corps).
            // On apparie desormais ce qui s'apparie sans ambiguite — les deux
            // cotes d'une meme face (une couture), puis un usage direct avec un
            // usage inverse s'il n'en reste qu'un de chaque. Chaque paire devient
            // une arete de maillage a deux triangles ; le reste, ambigu, est laisse
            // tel quel et compte.
            for (const EdgeUse& u : v)                             // proteges de toute fusion, cf. etage C
                for (int i = 1; i <= (int)u.pol->NbNodes(); ++i) nmNodes.push_back(nodeOf(u, i));
            std::vector<char> done(v.size(), 0);
            int paired = 0;
            for (size_t i = 0; i < v.size(); ++i)
                for (size_t j = i + 1; j < v.size() && !done[i]; ++j)
                    if (!done[j] && v[i].slot == v[j].slot && v[i].pol.get() != v[j].pol.get()
                        && sewPair(v[i], v[j])) { done[i] = done[j] = 1; paired++; }
            std::vector<size_t> rest;
            for (size_t i = 0; i < v.size(); ++i) if (!done[i]) rest.push_back(i);
            if (rest.size() == 2 && v[rest[0]].rev != v[rest[1]].rev && sewPair(v[rest[0]], v[rest[1]])) {
                paired++; rest.clear();
            }
            diag.edgesTopo += paired;
            if (!rest.empty()) diag.edgesOverUsed++;
            else diag.edgesNmPaired++;
            continue;
        }
        if (v.size() != 2) continue;                          // bord franc du B-Rep
        if (v[0].slot == v[1].slot && v[0].pol.get() == v[1].pol.get()) {
            // Meme face, MEME polygone : OCCT n'expose qu'un cote du seam par
            // cette API. Rien a coudre exactement ici — l'etage B s'en charge,
            // et on le compte pour que le releve reste honnete.
            diag.edgesSeamOnly++;
            continue;
        }

        if (!sewPair(v[0], v[1])) { diag.edgesMismatch++; continue; } // -> etage B
        diag.edgesTopo++;
    }

    // [FIX 27/09] Triangles d'un slot, en noeuds GLOBAUX, sens de la face
    // applique : ceux d'OCCT, ou — quand l'etage A' a du ecarter une
    // triangulation absente ou incoherente — ceux de son remplissage.
    std::vector<char> replaced(slots.size(), 0);
    std::vector<std::vector<uint32_t>> fillTris(slots.size());   // sens naturel de la surface
    auto forSlotTris = [&](uint32_t si, auto&& fn) {
        const FaceSlot& s = slots[si];
        const bool reversed = (s.face.Orientation() == TopAbs_REVERSED);
        if (replaced[si]) {
            const std::vector<uint32_t>& ft = fillTris[si];
            for (size_t k = 0; k + 2 < ft.size(); k += 3)
                if (reversed) fn(ft[k], ft[k+2], ft[k+1]); else fn(ft[k], ft[k+1], ft[k+2]);
            return;
        }
        if (!s.nb) return;
        const int nt = (int)s.tri->NbTriangles();
        for (int i = 1; i <= nt; ++i) {
            Standard_Integer a, b, c;
            s.tri->Triangle(i).Get(a, b, c);
            if (reversed) { const Standard_Integer t = b; b = c; c = t; }
            fn(s.off + (uint32_t)a - 1, s.off + (uint32_t)b - 1, s.off + (uint32_t)c - 1);
        }
    };

    // ── Soupe indexee a partir de l'etat courant du DSU. `remap` compacte les
    // classes d'equivalence en indices contigus.
    // [FIX 27/09] Seules les classes REFERENCEES par un triangle recoivent un
    // indice : les noeuds d'une triangulation ecartee par l'etage A' ne doivent
    // pas sortir comme sommets isoles. `remap` vaut UINT32_MAX pour eux. Sur un
    // corps sans remplissage, tous les noeuds sont references : rien ne change.
    std::vector<uint32_t> remap, triIdx;
    uint32_t vertsOut = 0;
    auto rebuild = [&]() {
        const uint32_t nAll = (uint32_t)(pp.size() / 3);
        std::vector<char> used(nAll, 0);
        for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si)
            forSlotTris(si, [&](uint32_t a, uint32_t b, uint32_t c) {
                used[dsu.find(a)] = 1; used[dsu.find(b)] = 1; used[dsu.find(c)] = 1;
            });
        std::vector<uint32_t> id(nAll, UINT32_MAX);
        remap.assign(nAll, UINT32_MAX);
        vertsOut = 0;
        for (uint32_t g = 0; g < nAll; ++g) {
            const uint32_t r = dsu.find(g);
            if (!used[r]) continue;
            if (id[r] == UINT32_MAX) id[r] = vertsOut++;
            remap[g] = id[r];
        }
        triIdx.clear();
        for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si)
            forSlotTris(si, [&](uint32_t a, uint32_t b, uint32_t c) {
                triIdx.push_back(remap[a]); triIdx.push_back(remap[b]); triIdx.push_back(remap[c]);
            });
    };
    rebuild();

    // ═══ ETAGE A' — faces que BRepMesh n'a pas su trianguler ═══════════════
    // [FIX 27/09 — Nass] Mesure sur le jeu tests/step (OCCT 7.6.3), trois cas
    // ou la face elle-meme, et non la couture, laisse le trou :
    //   - pas de triangulation du tout. Tronc de cone de conical-surface.step :
    //     BRepMesh rend « Failure » quelle que soit la deflexion, Delabella
    //     compris, alors que la MEME surface bornee par sa boite UV se maille
    //     (le contour, pas la surface, le fait echouer). Et des faces-lamelles
    //     d'aire nulle — plage v de largeur 0, ou deux aretes confondues en 3D
    //     (KR600, corps 17) — qu'AUCUN mailleur ne peut trianguler ;
    //   - une triangulation qui ne respecte pas ses propres aretes, alors que
    //     BRepMesh rend « succes » : faces planes a dix contours du KR600
    //     (corps 0 a 3), 44 segments sur 48 d'un cercle absents des triangles.
    //     Le recouvrement des contraintes de bord a echoue en silence.
    // Dans les trois cas il manque des triangles la ou la face est, et aucune
    // tolerance de couture ne comble une face absente (cf. step-declare.js).
    //
    // Le remede ne devine rien : la face est retriangulee sur les noeuds que ses
    // voisines ont DEJA poses sur leurs aretes communes. Le bord est donc
    // conforme par construction — memes sommets, a l'indice pres, pas de jointure
    // en T possible. Le contour vient de BRepTools_WireExplorer, les UV des
    // pcurves ; decoupe d'oreilles dans le plan UV (repli : plan moyen de Newell,
    // puis eventail), puis raffinement des seules aretes INTERIEURES tant que le
    // milieu s'ecarte de la surface de plus que la deflexion de la piece.
    //
    // Cout : l'etage ne s'arme que si la couture exacte laisse une arete nue ou
    // qu'une face n'a pas de triangulation. Un corps sain ne paie rien.
    // Aretes nues de la soupe courante ; rend aussi « au moins une arete a plus
    // de deux triangles ». Un seul comptage sert a armer l'etage A' ET, s'il ne
    // s'arme pas, d'entree a l'etage B.
    auto nakedList = [&](std::vector<std::pair<uint32_t,uint32_t>>& outNaked) -> bool {
        std::unordered_map<uint64_t, int> ec;
        ec.reserve(triIdx.size());
        for (size_t t = 0; t + 2 < triIdx.size(); t += 3) {
            ec[edgeKey(triIdx[t],   triIdx[t+1])]++;
            ec[edgeKey(triIdx[t+1], triIdx[t+2])]++;
            ec[edgeKey(triIdx[t+2], triIdx[t])]++;
        }
        outNaked.clear();
        bool over = false;
        for (size_t t = 0; t + 2 < triIdx.size(); t += 3) {
            const uint32_t v[3] = { triIdx[t], triIdx[t+1], triIdx[t+2] };
            for (int k = 0; k < 3; ++k) {
                const uint32_t a = v[k], b = v[(k+1)%3];
                auto it = ec.find(edgeKey(a,b));
                if (it == ec.end()) continue;
                if (it->second == 1) outNaked.push_back({a,b});
                else if (it->second > 2) over = true;
            }
        }
        return over;
    };
    std::vector<std::pair<uint32_t,uint32_t>> nakedA;
    bool armedA = false;
    {
        bool arm = false;
        for (const FaceSlot& s : slots) if (!s.nb) { arm = true; break; }
        if (nakedList(nakedA) || !nakedA.empty()) arm = true;
        armedA = arm;
        if (arm) {
            // ── Detection : triangulation absente, ou dont le bord ne suit pas
            // les polygones de ses propres aretes (segment de polygone absent ou
            // interieur, bord de triangulation hors polygone, arete a 3 triangles).
            auto consistent = [&](uint32_t si) -> bool {
                const FaceSlot& s = slots[si];
                std::unordered_map<uint64_t, int> ec;
                const int nt = (int)s.tri->NbTriangles();
                ec.reserve((size_t)nt * 3);
                for (int i = 1; i <= nt; ++i) {
                    Standard_Integer a, b, c;
                    s.tri->Triangle(i).Get(a, b, c);
                    ec[edgeKey((uint32_t)a, (uint32_t)b)]++;
                    ec[edgeKey((uint32_t)b, (uint32_t)c)]++;
                    ec[edgeKey((uint32_t)c, (uint32_t)a)]++;
                }
                std::unordered_set<uint64_t> seg;
                for (TopExp_Explorer ee(s.face, TopAbs_EDGE); ee.More(); ee.Next()) {
                    const TopAbs_Orientation o = ee.Current().Orientation();
                    if (o == TopAbs_INTERNAL || o == TopAbs_EXTERNAL) continue;
                    const Handle(BRep_TEdge) te = Handle(BRep_TEdge)::DownCast(ee.Current().TShape());
                    if (te.IsNull()) continue;
                    for (const Handle(BRep_CurveRepresentation)& cr : te->Curves()) {
                        if (cr.IsNull() || !cr->IsPolygonOnTriangulation()) continue;
                        if (cr->Triangulation().get() != s.tri.get()) continue;
                        // PolygonOnTriangulation2() LEVE Standard_DomainError sur une
                        // representation non fermee : on ne l'appelle que sur une couture.
                        const int nPol = cr->IsPolygonOnClosedTriangulation() ? 2 : 1;
                        for (int w = 0; w < nPol; ++w) {
                            const Handle(Poly_PolygonOnTriangulation)& P = w ? cr->PolygonOnTriangulation2()
                                                                            : cr->PolygonOnTriangulation();
                            if (P.IsNull()) continue;
                            for (int i = 1; i < P->NbNodes(); ++i)
                                if (P->Node(i) != P->Node(i+1))
                                    seg.insert(edgeKey((uint32_t)P->Node(i), (uint32_t)P->Node(i+1)));
                        }
                    }
                }
                for (uint64_t k : seg) { auto it = ec.find(k); if (it == ec.end() || it->second != 1) return false; }
                for (const auto& kv : ec) {
                    if (kv.second > 2) return false;
                    if (kv.second == 1 && !seg.count(kv.first)) return false;
                }
                return true;
            };
            for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si)
                if (!slots[si].nb || !consistent(si)) replaced[si] = 1;

            const double fillDefl = bodyDefl;

            auto newNode = [&](const gp_Pnt& p) -> uint32_t {
                pp.push_back(p.X()); pp.push_back(p.Y()); pp.push_back(p.Z());
                return dsu.add();
            };
            // Un sommet topologique = une seule classe, quel que soit le polygone
            // qui l'a fourni : c'est l'identite du B-Rep, pas une tolerance.
            std::unordered_map<const void*, uint32_t> vtxNode;
            auto vertexNode = [&](const TopoDS_Vertex& V, uint32_t cand) -> uint32_t {
                const void* k = V.TShape().get();
                auto it = vtxNode.find(k);
                if (it != vtxNode.end()) { if (cand != UINT32_MAX) dsu.unite(it->second, cand); return it->second; }
                const uint32_t n = (cand != UINT32_MAX) ? cand : newNode(BRep_Tool::Pnt(V));
                vtxNode.emplace(k, n);
                return n;
            };
            // Discretisation d'une arete, dans le sens de son parametre : le
            // polygone d'une face voisine SAINE (memes noeuds que la voisine), a
            // defaut n'importe quel polygone, a defaut une discretisation propre,
            // memorisee pour que les deux cotes d'une couture la partagent.
            struct Chain { std::vector<uint32_t> g; std::vector<double> t; };
            std::unordered_map<const void*, Chain> ownChain;
            auto chainOf = [&](const TopoDS_Edge& eAny, const TopoDS_Face& fFwd, Chain& ch) -> bool {
                const TopoDS_Edge E = TopoDS::Edge(eAny.Oriented(TopAbs_FORWARD));
                const void* key = E.TShape().get();
                TopoDS_Vertex V0, V1;
                TopExp::Vertices(E, V0, V1);
                ch.g.clear(); ch.t.clear();
                if (V0.IsNull() || V1.IsNull()) return false;
                if (BRep_Tool::Degenerated(E)) {
                    // Apex, pole : un seul point 3D, mais un segment dans le plan UV.
                    double f = 0, l = 0;
                    BRep_Tool::Range(E, fFwd, f, l);
                    const uint32_t n = vertexNode(V0, UINT32_MAX);
                    const int k = 8;
                    for (int i = 0; i <= k; ++i) { ch.g.push_back(n); ch.t.push_back(f + (l - f) * i / k); }
                    return true;
                }
                const EdgeUse* best = nullptr;
                auto it = uses.find(key);
                if (it != uses.end())
                    for (const EdgeUse& u : it->second) {
                        if (!replaced[u.slot]) { best = &u; break; }
                        if (!best) best = &u;
                    }
                bool own = false;
                if (best) {
                    const int n = (int)best->pol->NbNodes();
                    for (int i = 1; i <= n; ++i) ch.g.push_back(nodeOf(*best, i));
                    if (best->pol->HasParameters()) {
                        for (int i = 1; i <= n; ++i) ch.t.push_back(best->pol->Parameter(i));
                    } else {
                        // Polygone sans parametres (BRepMesh en range toujours ; repli
                        // seulement) : abscisse curviligne sur [f, l]. Suffisant ici, ou
                        // le parametre ne sert qu'a placer le noeud dans le plan UV.
                        double f = 0, l = 0;
                        BRep_Tool::Range(E, f, l);
                        std::vector<double> acc(1, 0.0);
                        for (int i = 2; i <= n; ++i) {
                            const uint32_t g0 = ch.g[(size_t)i - 2], g1 = ch.g[(size_t)i - 1];
                            acc.push_back(acc.back() + distG(g0, g1));
                        }
                        for (int i = 0; i < n; ++i)
                            ch.t.push_back(acc.back() > 0.0 ? f + (l - f) * acc[(size_t)i] / acc.back() : f);
                    }
                    if (n >= 2 && ch.t.front() > ch.t.back()) {
                        std::reverse(ch.g.begin(), ch.g.end());
                        std::reverse(ch.t.begin(), ch.t.end());
                    }
                } else {
                    auto oc = ownChain.find(key);
                    if (oc != ownChain.end()) ch = oc->second;
                    else {
                        double f = 0, l = 0;
                        BRep_Tool::Range(E, f, l);
                        BRepAdaptor_Curve C(E);
                        GCPnts_TangentialDeflection disc(C, f, l, ANGULAR_DEFLECTION, fillDefl, 2);
                        const int n = disc.NbPoints();
                        for (int i = 1; i <= n; ++i) {
                            ch.t.push_back(disc.Parameter(i));
                            ch.g.push_back((i == 1 || i == n) ? UINT32_MAX : newNode(disc.Value(i)));
                        }
                        own = true;
                    }
                }
                if (ch.g.size() < 2) return false;
                ch.g.front() = vertexNode(V0, ch.g.front());
                ch.g.back()  = vertexNode(V1, ch.g.back());
                if (own) ownChain.emplace(key, ch);
                return true;
            };
            // Contour d'un fil, dans l'ordre du fil, avec l'UV de chaque noeud
            // lu sur la pcurve de CE cote de l'arete (une couture a deux pcurves).
            // Rend 1 si le contour est exploitable, 0 s'il tient en moins de trois
            // noeuds (lamelle : ses aretes coincident, il n'y a rien a trianguler),
            // -1 si une arete n'a pu etre lue (ni discretisation, ni pcurve).
            struct LoopPt { uint32_t g; double u, v; };
            auto buildLoop = [&](const TopoDS_Wire& W, const TopoDS_Face& fFwd,
                                 std::vector<LoopPt>& loop) -> int {
                loop.clear();
                for (BRepTools_WireExplorer we(W, fFwd); we.More(); we.Next()) {
                    const TopoDS_Edge& E = we.Current();
                    if (E.Orientation() == TopAbs_INTERNAL || E.Orientation() == TopAbs_EXTERNAL) continue;
                    Chain ch;
                    if (!chainOf(E, fFwd, ch)) return -1;
                    double f = 0, l = 0;
                    Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(E, fFwd, f, l);
                    if (pc.IsNull()) return -1;
                    const bool rev = (E.Orientation() == TopAbs_REVERSED);
                    const size_t n = ch.g.size();
                    for (size_t k = 0; k < n; ++k) {
                        const size_t i = rev ? n - 1 - k : k;
                        if (k == 0 && !loop.empty()) { dsu.unite(loop.back().g, ch.g[i]); continue; }
                        const gp_Pnt2d uv = pc->Value(ch.t[i]);
                        loop.push_back(LoopPt{ ch.g[i], uv.X(), uv.Y() });
                    }
                }
                if (loop.size() > 1) { dsu.unite(loop.back().g, loop.front().g); loop.pop_back(); }
                return loop.size() >= 3 ? 1 : 0;
            };
            auto P3 = [&](uint32_t g) { return gp_Pnt(pp[(size_t)g*3], pp[(size_t)g*3+1], pp[(size_t)g*3+2]); };

            // Remplissage d'UNE face : 1 remplie, 0 effondree (lamelle a deux
            // noeuds : les voisines portent deja le meme segment, rien a emettre),
            // -1 echec.
            auto fillFace = [&](uint32_t si) -> int {
                const TopoDS_Face fFwd = TopoDS::Face(slots[si].face.Oriented(TopAbs_FORWARD));
                const TopoDS_Wire outerW = BRepTools::OuterWire(fFwd);
                if (outerW.IsNull()) return -1;
                std::vector<std::vector<LoopPt>> loops(1);
                const int st = buildLoop(outerW, fFwd, loops[0]);
                if (st <= 0) { fillTris[si].clear(); return st; }
                for (TopExp_Explorer we(fFwd, TopAbs_WIRE); we.More(); we.Next()) {
                    const TopoDS_Wire W = TopoDS::Wire(we.Current());
                    if (W.IsSame(outerW)) continue;
                    std::vector<LoopPt> lp;
                    if (buildLoop(W, fFwd, lp) > 0) loops.push_back(std::move(lp));
                }
                // [FIX 28/09] FILS QUI SE TOUCHENT. Rocky_House, corps « Body », face
                // plane 767 : un trou relie au contour exterieur par une arete de
                // 1,6 um que la face parcourt DEUX fois — une fois dans chaque fil,
                // en sens opposes. C'est une fente de largeur nulle, pas un trou : la
                // traiter comme tel fait echouer la decoupe stricte, et le mode force
                // pose alors des diagonales qui se confondent des que la micro-arete
                // est refermee (une arete a quatre triangles). On raccorde donc le
                // trou au contour par cette arete commune, qui disparait de la face
                // (ses deux cotes y sont interieurs) ; a defaut d'arete commune, par
                // un sommet commun (pont de longueur nulle). Identite topologique
                // (classe du DSU), jamais une distance.
                {
                    auto idp = [&](const LoopPt& p) { return dsu.find(p.g); };
                    for (size_t hi = 1; hi < loops.size(); ) {
                        std::vector<LoopPt>& X = loops[0];
                        const std::vector<LoopPt>& Y = loops[hi];
                        const size_t n = X.size(), m = Y.size();
                        std::vector<LoopPt> merged;
                        for (size_t i = 0; i < n && merged.empty(); ++i) {
                            const uint32_t a = idp(X[i]), b = idp(X[(i + 1) % n]);
                            for (size_t j = 0; j < m; ++j) {
                                if (idp(Y[j]) != b || idp(Y[(j + 1) % m]) != a) continue;
                                // X tourne pour finir sur a -> b : b, ..., a ; puis Y
                                // apres a, jusqu'avant b — l'arete a-b disparait.
                                for (size_t k = 1; k <= n; ++k) merged.push_back(X[(i + k) % n]);
                                for (size_t k = 2; k < m; ++k) merged.push_back(Y[(j + k) % m]);
                                break;
                            }
                        }
                        for (size_t i = 0; i < n && merged.empty(); ++i)
                            for (size_t j = 0; j < m; ++j) {
                                if (idp(X[i]) != idp(Y[j])) continue;
                                for (size_t k = 0; k < n; ++k) merged.push_back(X[(i + k) % n]);
                                for (size_t k = 0; k < m; ++k) merged.push_back(Y[(j + k) % m]);
                                break;
                            }
                        if (merged.size() >= 3) {
                            X.swap(merged);
                            loops.erase(loops.begin() + (std::ptrdiff_t)hi);
                            hi = 1;   // le contour a grandi : il peut toucher un autre trou
                        } else ++hi;
                    }
                }
                // Sommets LOCAUX : un meme noeud global peut y figurer deux fois
                // (les deux cotes d'une couture n'ont pas le meme UV).
                std::vector<double> U, V;
                std::vector<uint32_t> G, outer;
                std::vector<std::vector<uint32_t>> holes;
                std::unordered_set<uint64_t> bnd;   // segments de contour : jamais coupes
                for (size_t li = 0; li < loops.size(); ++li) {
                    std::vector<uint32_t> idx;
                    for (const LoopPt& p : loops[li]) {
                        idx.push_back((uint32_t)G.size());
                        G.push_back(p.g); U.push_back(p.u); V.push_back(p.v);
                    }
                    for (size_t k = 0; k < idx.size(); ++k)
                        bnd.insert(edgeKey(idx[k], idx[(k + 1) % idx.size()]));
                    if (li == 0) outer = std::move(idx); else holes.push_back(std::move(idx));
                }
                std::vector<uint32_t> T;
                bool viaUV = false;
                // Deux domaines 2D candidats : le plan UV — le seul ou le sens des
                // triangles est celui de la surface par construction — et le plan
                // moyen du contour 3D (Newell), quand l'UV est degenere.
                std::vector<std::pair<double, double>> Puv, Pnw;
                if (G.size() <= 4000) {
                    double a = 0, u0 = U[outer[0]], u1 = u0, v0 = V[outer[0]], v1 = v0;
                    for (size_t k = 0; k < outer.size(); ++k) {
                        const uint32_t p = outer[k], q = outer[(k + 1) % outer.size()];
                        a += U[p] * V[q] - U[q] * V[p];
                        u0 = std::min(u0, U[p]); u1 = std::max(u1, U[p]);
                        v0 = std::min(v0, V[p]); v1 = std::max(v1, V[p]);
                    }
                    const double box = (u1 - u0) * (v1 - v0);
                    if (box > 0.0 && std::fabs(0.5 * a) > 1e-9 * box) {
                        Puv.resize(G.size());
                        for (size_t k = 0; k < G.size(); ++k) Puv[k] = { U[k], V[k] };
                    }
                    double nx = 0, ny = 0, nz = 0;
                    for (size_t k = 0; k < outer.size(); ++k) {
                        const gp_Pnt pa = P3(G[outer[k]]), pb = P3(G[outer[(k + 1) % outer.size()]]);
                        nx += (pa.Y() - pb.Y()) * (pa.Z() + pb.Z());
                        ny += (pa.Z() - pb.Z()) * (pa.X() + pb.X());
                        nz += (pa.X() - pb.X()) * (pa.Y() + pb.Y());
                    }
                    const double nn = std::sqrt(nx*nx + ny*ny + nz*nz);
                    if (nn > 0.0) {
                        const gp_Dir N(nx / nn, ny / nn, nz / nn);
                        const gp_Dir E1 = (std::fabs(N.X()) < 0.9) ? N.Crossed(gp_Dir(1, 0, 0)) : N.Crossed(gp_Dir(0, 1, 0));
                        const gp_Dir E2 = N.Crossed(E1);
                        Pnw.resize(G.size());
                        for (size_t k = 0; k < G.size(); ++k) {
                            const gp_XYZ p = P3(G[k]).XYZ();
                            Pnw[k] = { p.Dot(E1.XYZ()), p.Dot(E2.XYZ()) };
                        }
                    }
                }
                // 0. LAMELLE (aire < 1e-3 x perimetre^2, sans trou). Aire EXACTE de la
                // face (BRepGProp), pas celle du contour projete : un cylindre, dont
                // le contour parcourt deux cercles en sens opposes, a une aire de
                // Newell nulle et n'est pas une lamelle. On y decoupe toujours
                // l'oreille dont la diagonale 3D est la plus COURTE : sur une bande
                // de 0,6 um (KR600, corps 19) ce sont les barreaux d'un flanc a
                // l'autre, sur une lentille la decoupe avance depuis les pointes.
                // Chaque barreau sous le micron devient une micro-arete que la
                // contraction de l'etage C refermera proprement — la ou un eventail,
                // reliant un sommet a tous les autres, violait la condition de lien
                // et laissait le controle de NASSCAD les ecraser a l'aveugle.
                bool zipped = false;
                if (holes.empty() && outer.size() >= 4) {
                    double per = 0.0, area = -1.0;
                    for (size_t k = 0; k < outer.size(); ++k)
                        per += P3(G[outer[k]]).Distance(P3(G[outer[(k + 1) % outer.size()]]));
                    try {
                        GProp_GProps gp;
                        BRepGProp::SurfaceProperties(fFwd, gp);
                        area = std::fabs(gp.Mass());
                    } catch (...) { area = -1.0; }
                    if (per > 0.0 && area >= 0.0 && area < 1e-3 * per * per) {
                        std::vector<uint32_t> v(outer);
                        std::unordered_set<uint64_t> have;
                        auto gid = [&](uint32_t lv) { return dsu.find(G[lv]); };
                        for (size_t k = 0; k < v.size(); ++k) have.insert(edgeKey(gid(v[k]), gid(v[(k + 1) % v.size()])));
                        while (v.size() > 3) {
                            size_t pick = SIZE_MAX, alt = SIZE_MAX;
                            double best = 1e300, bestAlt = 1e300;
                            for (size_t i = 0; i < v.size(); ++i) {
                                const uint32_t pv = v[(i + v.size() - 1) % v.size()], nv = v[(i + 1) % v.size()];
                                const double d = P3(G[pv]).SquareDistance(P3(G[nv]));
                                const bool clash = gid(pv) == gid(nv) || have.count(edgeKey(gid(pv), gid(nv)));
                                if (!clash && d < best) { best = d; pick = i; }
                                if (d < bestAlt) { bestAlt = d; alt = i; }
                            }
                            if (pick == SIZE_MAX) pick = alt;          // tout redoublerait : le moins long
                            const size_t ip = (pick + v.size() - 1) % v.size(), in = (pick + 1) % v.size();
                            have.insert(edgeKey(gid(v[ip]), gid(v[in])));
                            T.push_back(v[ip]); T.push_back(v[pick]); T.push_back(v[in]);
                            v.erase(v.begin() + (std::ptrdiff_t)pick);
                        }
                        T.push_back(v[0]); T.push_back(v[1]); T.push_back(v[2]);
                        zipped = true;
                    }
                }
                // 1. UV strict, 2. Newell strict, 3. force (UV si disponible), 4. eventail.
                std::vector<uint32_t> ident(G.size());   // identite topologique de chaque sommet local
                for (size_t k = 0; k < G.size(); ++k) ident[k] = dsu.find(G[k]);
                // Newell n'est tente que si l'UV est degenere : quand l'UV existe et que
                // la decoupe stricte y echoue, c'est le contour qui se croise, et il se
                // croise aussi dans le plan moyen (sur une face plane, c'est le meme).
                if (T.empty() && !Puv.empty()) viaUV = fillTriangulate2D(Puv, outer, holes, T, false, &ident);
                if (!viaUV && T.empty() && Puv.empty() && !Pnw.empty()
                    && !fillTriangulate2D(Pnw, outer, holes, T, false, &ident)) T.clear();
                if (!viaUV && T.empty()) {
                    if (!Puv.empty()) viaUV = fillTriangulate2D(Puv, outer, holes, T, true, &ident);
                    if (!viaUV && !Pnw.empty() && !fillTriangulate2D(Pnw, outer, holes, T, true, &ident)) T.clear();
                }
                // 3. Eventail sur le contour exterieur : topologiquement ferme, meme a aire nulle.
                if (T.empty())
                    for (size_t k = 1; k + 1 < outer.size(); ++k) {
                        T.push_back(outer[0]); T.push_back(outer[k]); T.push_back(outer[k + 1]);
                    }
                if (T.empty()) return -1;

                BRepAdaptor_Surface S(fFwd);
                // Raffinement, sur le seul chemin UV (ailleurs l'UV ne decrit pas la
                // face). Mesure du premier jet — couper au milieu toute arete dont le
                // milieu s'ecarte : tronc de cone de conical-surface.step, 342 sommets
                // pour tout le corps avant, 25 864 apres, et encore plafonne : la
                // decoupe d'oreilles rend des eventails, et couper un eventail en
                // fabrique d'autres. Ici, la methode standard : Delaunay dans le plan
                // (u.|Su|, v.|Sv|) — a peu pres isometrique a la surface — par
                // basculements de Lawson, puis insertion au centre de tout triangle
                // qui s'ecarte de la surface de plus que la deflexion, et Delaunay de
                // nouveau. Les segments de contour ne sont JAMAIS bascules ni coupes :
                // c'est ce qui garde la conformite avec les faces voisines.
                if (viaUV && S.GetType() != GeomAbs_Plane) {
                    double u0 = U[0], u1 = U[0], v0 = V[0], v1 = V[0];
                    for (size_t k = 0; k < U.size(); ++k) {
                        u0 = std::min(u0, U[k]); u1 = std::max(u1, U[k]);
                        v0 = std::min(v0, V[k]); v1 = std::max(v1, V[k]);
                    }
                    double su = 0.0, sv = 0.0; int ns = 0;
                    for (int i = 0; i < 3; ++i)
                        for (int j = 0; j < 3; ++j) {
                            gp_Pnt p; gp_Vec du, dv;
                            S.D1(u0 + (u1 - u0) * (0.25 + 0.25 * i), v0 + (v1 - v0) * (0.25 + 0.25 * j), p, du, dv);
                            su += du.Magnitude(); sv += dv.Magnitude(); ns++;
                        }
                    su = (su > 0.0) ? su / ns : 1.0;
                    sv = (sv > 0.0) ? sv / ns : 1.0;
                    auto X = [&](uint32_t k) { return U[k] * su; };
                    auto Y = [&](uint32_t k) { return V[k] * sv; };
                    auto orient = [&](uint32_t a, uint32_t b, uint32_t c) {
                        return (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a));
                    };
                    // d dans le cercle circonscrit de (a, b, c), ce dernier dans le sens direct.
                    auto inCircle = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
                        const double adx = X(a) - X(d), ady = Y(a) - Y(d);
                        const double bdx = X(b) - X(d), bdy = Y(b) - Y(d);
                        const double cdx = X(c) - X(d), cdy = Y(c) - Y(d);
                        return (adx*adx + ady*ady) * (bdx*cdy - cdx*bdy)
                             - (bdx*bdx + bdy*bdy) * (adx*cdy - cdx*ady)
                             + (cdx*cdx + cdy*cdy) * (adx*bdy - bdx*ady);
                    };
                    auto lawson = [&]() {
                        for (int it = 0; it < 64; ++it) {
                            std::unordered_map<uint64_t, std::pair<uint32_t, uint32_t>> e2t;
                            const uint32_t nt = (uint32_t)(T.size() / 3);
                            e2t.reserve((size_t)nt * 3);
                            for (uint32_t t = 0; t < nt; ++t)
                                for (int k = 0; k < 3; ++k) {
                                    auto ins = e2t.emplace(edgeKey(T[t*3+k], T[t*3+(k+1)%3]), std::make_pair(t, UINT32_MAX));
                                    if (!ins.second) ins.first->second.second = t;
                                }
                            std::vector<char> busy(nt, 0);
                            bool flipped = false;
                            for (const auto& kv : e2t) {
                                const uint32_t t1 = kv.second.first, t2 = kv.second.second;
                                if (t2 == UINT32_MAX || busy[t1] || busy[t2] || bnd.count(kv.first)) continue;
                                uint32_t a = UINT32_MAX, b = 0, c = 0, d = UINT32_MAX;
                                for (int k = 0; k < 3; ++k) {
                                    const uint32_t x = T[t1*3+k], y = T[t1*3+(k+1)%3];
                                    if (edgeKey(x, y) == kv.first) { a = x; b = y; c = T[t1*3+(k+2)%3]; }
                                }
                                for (int k = 0; k < 3; ++k)
                                    if (T[t2*3+k] == b && T[t2*3+(k+1)%3] == a) d = T[t2*3+(k+2)%3];
                                if (a == UINT32_MAX || d == UINT32_MAX || c == d) continue;
                                if (e2t.count(edgeKey(c, d))) continue;
                                if (!(inCircle(a, b, c, d) > 0.0)) continue;
                                if (orient(c, a, d) <= 0.0 || orient(d, b, c) <= 0.0) continue;
                                T[t1*3] = c; T[t1*3+1] = a; T[t1*3+2] = d;
                                T[t2*3] = d; T[t2*3+1] = b; T[t2*3+2] = c;
                                busy[t1] = busy[t2] = 1;
                                flipped = true;
                            }
                            if (!flipped) break;
                        }
                    };
                    lawson();
                    const size_t maxLocal = G.size() * 8 + 4000;
                    for (int pass = 0; pass < 48 && G.size() < maxLocal; ++pass) {
                        bool changed = false;
                        const uint32_t nt = (uint32_t)(T.size() / 3);
                        for (uint32_t t = 0; t < nt && G.size() < maxLocal; ++t) {
                            const uint32_t a = T[t*3], b = T[t*3+1], c = T[t*3+2];
                            const double uc = (U[a] + U[b] + U[c]) / 3.0, vc = (V[a] + V[b] + V[c]) / 3.0;
                            const gp_Pnt pa = P3(G[a]), pb = P3(G[b]), pc = P3(G[c]);
                            double dev = S.Value(uc, vc).Distance(gp_Pnt((pa.XYZ() + pb.XYZ() + pc.XYZ()) / 3.0));
                            const uint32_t e[3][2] = { { a, b }, { b, c }, { c, a } };
                            for (const auto& ed : e) {
                                if (bnd.count(edgeKey(ed[0], ed[1]))) continue;
                                const gp_Pnt m = S.Value(0.5 * (U[ed[0]] + U[ed[1]]), 0.5 * (V[ed[0]] + V[ed[1]]));
                                dev = std::max(dev, m.Distance(gp_Pnt((P3(G[ed[0]]).XYZ() + P3(G[ed[1]]).XYZ()) / 2.0)));
                            }
                            if (dev <= fillDefl || orient(a, b, c) <= 0.0) continue;
                            // Insertion au centre : trois triangles, meme sens.
                            const uint32_t m = (uint32_t)G.size();
                            G.push_back(newNode(S.Value(uc, vc))); U.push_back(uc); V.push_back(vc);
                            T[t*3+2] = m;
                            T.push_back(b); T.push_back(c); T.push_back(m);
                            T.push_back(c); T.push_back(a); T.push_back(m);
                            changed = true;
                        }
                        if (!changed) break;
                        lawson();
                    }
                }
                // Sens : par construction dans le plan UV ; sinon on le verifie contre
                // la normale de la surface (Su x Sv), ponderee par l'aire. Pas sur
                // une lamelle : son aire est nulle, le signe n'y voudrait rien dire —
                // la fermeture eclair suit le sens du fil, c'est lui qui fait foi.
                if (!viaUV && !zipped) {
                    double score = 0.0;
                    for (size_t k = 0; k + 2 < T.size(); k += 3) {
                        const gp_Pnt a = P3(G[T[k]]), b = P3(G[T[k+1]]), c = P3(G[T[k+2]]);
                        const gp_Vec n = gp_Vec(a, b).Crossed(gp_Vec(a, c));
                        gp_Pnt p; gp_Vec du, dv;
                        S.D1((U[T[k]] + U[T[k+1]] + U[T[k+2]]) / 3.0, (V[T[k]] + V[T[k+1]] + V[T[k+2]]) / 3.0, p, du, dv);
                        const gp_Vec ns = du.Crossed(dv);
                        const double l = ns.Magnitude();
                        if (l > 1e-300) score += n.Dot(ns) / l;
                    }
                    if (score < 0.0)
                        for (size_t k = 0; k + 2 < T.size(); k += 3) std::swap(T[k+1], T[k+2]);
                }
                std::vector<uint32_t>& out = fillTris[si];
                out.clear();
                out.reserve(T.size());
                for (uint32_t lv : T) out.push_back(G[lv]);
                return 1;
            };

            for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si) {
                if (!replaced[si]) continue;
                int st = -1;
                try { st = fillFace(si); } catch (...) { st = -1; }
                if (st > 0) { if (slots[si].nb) diag.facesRedone++; else diag.facesFilled++; }
                else if (st == 0) diag.facesCollapsed++;
                else {
                    // Jamais pire qu'avant : une triangulation OCCT, meme douteuse,
                    // est gardee plutot que remplacee par rien.
                    fillTris[si].clear();
                    if (slots[si].nb) replaced[si] = 0; else diag.facesUnfilled++;
                }
            }
            rebuild();
        }
    }

    // Position representative de chaque sommet cousu : la MOYENNE de sa classe,
    // en double. C'est elle qui neutralise l'asymetrie float32 entre deux faces
    // qui partageaient deja le meme point en double.
    std::vector<double> vp;
    auto rebuildVertPos = [&]() {
        vp.assign((size_t)vertsOut * 3, 0.0);
        std::vector<uint32_t> cnt(vertsOut, 0);
        for (uint32_t g = 0; g < (uint32_t)remap.size(); ++g) {
            const uint32_t w = remap[g];
            if (w == UINT32_MAX) continue;   // [FIX 27/09] noeud d'une triangulation ecartee
            vp[(size_t)w*3]   += pp[(size_t)g*3];
            vp[(size_t)w*3+1] += pp[(size_t)g*3+1];
            vp[(size_t)w*3+2] += pp[(size_t)g*3+2];
            cnt[w]++;
        }
        for (uint32_t w = 0; w < vertsOut; ++w)
            if (cnt[w] > 1)
                for (int k = 0; k < 3; ++k) vp[(size_t)w*3+k] /= (double)cnt[w];
    };

    // ═══ ETAGE B — couture residuelle, bords uniquement, tolerance progressive
    // [FIX 27/09] Liste des aretes nues deja calculee avant l'etage A' (nakedList
    // est desormais definie plus haut) : on ne la refait que si A' a retouche
    // la soupe.
    std::vector<std::pair<uint32_t,uint32_t>> naked;
    if (armedA) nakedList(naked); else naked.swap(nakedA);
    if (!naked.empty() && diagLen > 0.0) {
        const double ladder[3] = { 1e-9 * diagLen, 1e-7 * diagLen, 1e-5 * diagLen };
        for (int li = 0; li < 3 && !naked.empty(); ++li) {
            const double tol = ladder[li];
            if (!(tol > 0.0)) continue;
            const std::vector<uint32_t> before = dsu.snapshot();
            rebuildVertPos();

            // Grille de pas `tol` sur le milieu d'arete, sondage des 27 cellules
            // voisines : une quantification seule rate les points a cheval sur
            // une frontiere de cellule, ce qui est precisement le piege dans
            // lequel tombe weldMeshLocal.
            auto cellOf = [&](double x, double y, double z) -> uint64_t {
                const int64_t i = (int64_t)std::floor(x / tol);
                const int64_t j = (int64_t)std::floor(y / tol);
                const int64_t k = (int64_t)std::floor(z / tol);
                return ((uint64_t)(uint32_t)i * 73856093ull)
                     ^ ((uint64_t)(uint32_t)j * 19349663ull)
                     ^ ((uint64_t)(uint32_t)k * 83492791ull);
            };
            auto midOf = [&](const std::pair<uint32_t,uint32_t>& e, double* m) {
                for (int k = 0; k < 3; ++k)
                    m[k] = 0.5 * (vp[(size_t)e.first*3+k] + vp[(size_t)e.second*3+k]);
            };
            // NB : surtout pas `near` — windows.h en fait un macro vide.
            auto closeTo = [&](uint32_t a, uint32_t b) -> bool {
                double d = 0;
                for (int k = 0; k < 3; ++k) {
                    const double t = vp[(size_t)a*3+k] - vp[(size_t)b*3+k];
                    d += t * t;
                }
                return d <= tol * tol;
            };

            std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
            grid.reserve(naked.size() * 2);
            for (uint32_t i = 0; i < (uint32_t)naked.size(); ++i) {
                double m[3]; midOf(naked[i], m);
                grid[cellOf(m[0], m[1], m[2])].push_back(i);
            }

            std::vector<char> taken(naked.size(), 0);
            int stitched = 0, flipped = 0;
            for (uint32_t i = 0; i < (uint32_t)naked.size(); ++i) {
                if (taken[i]) continue;
                double m[3]; midOf(naked[i], m);
                int bestJ = -1; bool bestFlip = false;
                for (int dx = -1; dx <= 1 && bestJ < 0; ++dx)
                for (int dy = -1; dy <= 1 && bestJ < 0; ++dy)
                for (int dz = -1; dz <= 1 && bestJ < 0; ++dz) {
                    auto it = grid.find(cellOf(m[0] + dx*tol, m[1] + dy*tol, m[2] + dz*tol));
                    if (it == grid.end()) continue;
                    for (uint32_t j : it->second) {
                        if (j == i || taken[j]) continue;
                        // Sens oppose = recollement coherent de deux bords.
                        if (closeTo(naked[i].first, naked[j].second) &&
                            closeTo(naked[i].second, naked[j].first)) {
                            bestJ = (int)j; bestFlip = false; break;
                        }
                        // Meme sens : on accepte, mais on le signale — symptome
                        // d'une orientation incoherente en amont.
                        if (closeTo(naked[i].first, naked[j].first) &&
                            closeTo(naked[i].second, naked[j].second)) {
                            bestJ = (int)j; bestFlip = true; break;
                        }
                    }
                }
                if (bestJ < 0) continue;
                const uint32_t j = (uint32_t)bestJ;
                if (bestFlip) {
                    dsu.unite(naked[i].first,  naked[j].first);
                    dsu.unite(naked[i].second, naked[j].second);
                    flipped++;
                } else {
                    dsu.unite(naked[i].first,  naked[j].second);
                    dsu.unite(naked[i].second, naked[j].first);
                }
                taken[i] = taken[j] = 1; stitched++;
            }
            if (!stitched) continue;

            rebuild();
            // Garde-fou : une passe qui fabrique une arete a plus de 2 triangles
            // est annulee EN BLOC. On prefere un bord ouvert, qui reste
            // reparable, a une arete sur-valencee, qui ne l'est plus.
            int nk = 0, ov = 0, bt = 0;
            analyzeTopology(triIdx, vertsOut, nk, ov, bt);
            if (ov > 0) { dsu.restore(before); rebuild(); continue; }

            diag.edgesResidual += stitched;
            diag.edgesFlipped  += flipped;
            diag.residualTol    = tol;
            nakedList(naked);
        }
    }

    // ═══ ETAGE C — nettoyage sans perte, et emission ══════════════════════
    MeshData md;
    md.name = name;
    if (color) {
        double sr, sg, sb;
        occtColorToSRGB(*color, sr, sg, sb);
        md.hasColor = true; md.r = (float)sr; md.g = (float)sg; md.b = (float)sb;
        md.a = alpha;
    }

    rebuildVertPos();
    // [FIX 27/09] md.positions n'est plus ecrit ici mais apres les passes de
    // nettoyage (contraction des micro-aretes, bascule de diagonales), qui
    // deplacent et retirent des sommets — cf. le compactage en fin d'etage.

    struct Run { uint32_t key; float r, g, b; uint32_t start, count; float a; };
    std::vector<Run> runs;
    auto colorKey = [](float r, float g, float b, float a) -> uint32_t {
        return ((uint32_t)std::lround(a * 255.0f) << 24)
             | ((uint32_t)std::lround(r * 255.0f) << 16)
             | ((uint32_t)std::lround(g * 255.0f) << 8)
             |  (uint32_t)std::lround(b * 255.0f);
    };

    // Cycle canonique (plus petit indice en tete) : distingue un vrai doublon
    // d'un triangle oppose, qu'on ne supprime pas.
    std::unordered_map<TriKey, uint8_t, TriKeyHash> seenTri;
    seenTri.reserve(triIdx.size() / 3 + 1);
    auto canon = [](uint32_t a, uint32_t b, uint32_t c, bool& opposed) -> TriKey {
        uint32_t x = a, y = b, z = c;
        if (y < x && y <= z)      { x = b; y = c; z = a; }
        else if (z < x && z <= y) { x = c; y = a; z = b; }
        opposed = (y > z);
        if (opposed) { const uint32_t t = y; y = z; z = t; }
        return TriKey{ x, y, z };
    };

    md.indices.reserve(triIdx.size());
    std::vector<uint32_t> triSlot;   // [FIX 27/09] face d'origine de chaque triangle emis
    triSlot.reserve(triIdx.size() / 3);
    std::vector<FaceRGB> slotCol(faceColors ? slots.size() : 0);   // [FIX 27/09] couleur de chaque face
    for (uint32_t si = 0; si < (uint32_t)slots.size(); ++si) {
        const FaceSlot& s = slots[si];
        // [FIX 27/09] triangles d'OCCT ou du remplissage (etage A'), cf. forSlotTris
        forSlotTris(si, [&](uint32_t ga, uint32_t gb, uint32_t gc) {
            const uint32_t ia = remap[ga], ib = remap[gb], ic = remap[gc];
            if (ia == ib || ib == ic || ic == ia) { diag.trisDegen++; return; }
            bool opposed = false;
            const TriKey k = canon(ia, ib, ic, opposed);
            const uint8_t bit = opposed ? 2 : 1;
            auto it = seenTri.find(k);
            if (it != seenTri.end()) {
                if (it->second & bit) { diag.trisDup++; return; }    // doublon strict
                diag.trisOpposed++;                                  // compte, garde
                it->second |= bit;
            } else seenTri.emplace(k, bit);
            md.indices.push_back(ia); md.indices.push_back(ib); md.indices.push_back(ic);
            triSlot.push_back(si);
        });
        if (faceColors) {
            FaceRGB c{ md.r, md.g, md.b, md.a };
            auto it = faceColors->find(s.face.TShape().get());
            if (it != faceColors->end()) c = it->second;
            slotCol[si] = c;
        }
    }

    // [FIX 27/09] MICRO-ARETES. Le B-Rep porte des aretes de quelques dixiemes
    // de micron (KR600 : un segment de 0,5 um, un arc de 0,0017 rad), et le
    // maillage en herite. Topologiquement rien a redire — le corps sort ici
    // etanche a l'indice pres. Mais le controle de NASSCAD (_weldAndCheckManifold,
    // tol=3) soude par cellules de 0,001 mm : il ECRASE ces aretes sans regarder
    // la topologie, et deux triangles qui se touchaient par un sommet se
    // retrouvent a partager une arete — mesure : jusqu'a 104 aretes a quatre
    // triangles sur un corps que MEDUSA livrait etanche.
    // On contracte donc nous-memes toute arete plus courte que kMicro, mais
    // SEULEMENT quand la condition de lien (Dey, Edelsbrunner, Guha, Nekhayev,
    // 1999 — la regle de toute decimation qui preserve la variete) garantit que
    // le resultat reste une variete : les voisins communs des deux extremites
    // sont exactement les sommets opposes a l'arete. kMicro = 2 um, au-dessus de
    // la diagonale d'une cellule du controle (racine de 3 x 1 um). Deplacement
    // maximal d'un sommet : 2 um, rien a l'ecran.
    std::vector<char> triDead(md.indices.size() / 3, 0);
    std::vector<char> touchedV(vertsOut, 0); // sommets deplaces par une contraction ou une fusion
    std::vector<char> nmVert(vertsOut, 0);   // sommets d'une arete non manifold DECLAREE
    for (uint32_t g : nmNodes)
        if (g < remap.size() && remap[g] != UINT32_MAX) nmVert[remap[g]] = 1;
    {
        const double sc = std::fabs(instLoc.Transformation().ScaleFactor());
        const double kMicro = 0.002 / (sc > 0.0 ? sc : 1.0);     // mm, dans le repere du prototype
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        auto len = [&](uint32_t a, uint32_t b) {
            const double dx = vp[(size_t)a*3] - vp[(size_t)b*3], dy = vp[(size_t)a*3+1] - vp[(size_t)b*3+1],
                         dz = vp[(size_t)a*3+2] - vp[(size_t)b*3+2];
            return std::sqrt(dx*dx + dy*dy + dz*dz);
        };
        std::vector<std::pair<double, uint64_t>> micro;
        for (uint32_t t = 0; t < ntri; ++t)
            for (int k = 0; k < 3; ++k) {
                const uint32_t a = md.indices[t*3+k], b = md.indices[t*3+(k+1)%3];
                if (a < b && !nmVert[a] && !nmVert[b]) { const double l = len(a, b); if (l < kMicro) micro.push_back({ l, edgeKey(a, b) }); }
            }
        if (!micro.empty()) {
            std::sort(micro.begin(), micro.end());
            std::vector<std::vector<uint32_t>> vt(vertsOut);       // sommet -> triangles vivants
            for (uint32_t t = 0; t < ntri; ++t)
                for (int k = 0; k < 3; ++k) vt[md.indices[t*3+k]].push_back(t);
            std::vector<uint32_t> rep(vertsOut);
            for (uint32_t v = 0; v < vertsOut; ++v) rep[v] = v;
            auto R = [&](uint32_t v) { while (rep[v] != v) { rep[v] = rep[rep[v]]; v = rep[v]; } return v; };
            auto neighbours = [&](uint32_t v, std::unordered_set<uint32_t>& out) {
                out.clear();
                for (uint32_t t : vt[v]) {
                    if (triDead[t]) continue;
                    for (int k = 0; k < 3; ++k) { const uint32_t w = md.indices[t*3+k]; if (w != v) out.insert(w); }
                }
            };
            std::unordered_set<uint32_t> na, nb;
            for (const auto& me : micro) {
                const uint32_t a = R((uint32_t)(me.second >> 32)), b = R((uint32_t)(me.second & 0xFFFFFFFFu));
                if (a == b || len(a, b) >= kMicro) continue;
                // Triangles portant l'arete (a, b), et leurs sommets opposes.
                std::vector<uint32_t> ab, opp;
                for (uint32_t t : vt[a]) {
                    if (triDead[t]) continue;
                    bool hasB = false; uint32_t o = UINT32_MAX;
                    for (int k = 0; k < 3; ++k) {
                        const uint32_t w = md.indices[t*3+k];
                        if (w == b) hasB = true; else if (w != a) o = w;
                    }
                    if (hasB) { ab.push_back(t); opp.push_back(o); }
                }
                if (ab.empty() || ab.size() > 2) continue;       // plus une arete, ou arete deja non manifold
                // Sur une coque OUVERTE : deux sommets de bord relies par une arete
                // interieure ne se contractent pas (on pincerait le bord).
                auto onBorder = [&](uint32_t v) {
                    std::unordered_map<uint32_t, int> c;
                    for (uint32_t t : vt[v]) {
                        if (triDead[t]) continue;
                        for (int k = 0; k < 3; ++k) { const uint32_t w = md.indices[t*3+k]; if (w != v) c[w]++; }
                    }
                    for (const auto& kv : c) if (kv.second == 1) return true;
                    return false;
                };
                if (ab.size() == 2 && onBorder(a) && onBorder(b)) continue;
                neighbours(a, na); neighbours(b, nb);
                size_t common = 0; bool linkOk = true;
                for (uint32_t w : na) if (nb.count(w)) {
                    common++;
                    if (std::find(opp.begin(), opp.end(), w) == opp.end()) { linkOk = false; break; }
                }
                if (!linkOk || common != opp.size()) continue;
                // Contraction de b sur a, au milieu : chaque sommet bouge de moins de kMicro/2.
                for (int k = 0; k < 3; ++k) vp[(size_t)a*3+k] = 0.5 * (vp[(size_t)a*3+k] + vp[(size_t)b*3+k]);
                for (uint32_t t : ab) triDead[t] = 1;
                for (uint32_t t : vt[b]) {
                    if (triDead[t]) continue;
                    for (int k = 0; k < 3; ++k) if (md.indices[t*3+k] == b) md.indices[t*3+k] = a;
                    vt[a].push_back(t);
                }
                vt[b].clear();
                rep[b] = a;
                touchedV[a] = 1;
                diag.microCollapsed++;
            }
        }
    }

    // [FIX 27/09] AMAS SOUS LE MICRON. La contraction ci-dessus refuse, a juste
    // titre, ce qui violerait la condition de lien. Mais ce qu'elle laisse, le
    // controle de NASSCAD le soudera quand meme, a l'aveugle, par cellules de
    // 0,001 mm : refuser ici ne protege rien, cela deplace seulement le defaut
    // chez le client. Cas mesures sur KR600 : une bande conique de 0,61 um de
    // haut entre deux cylindres (face 94 du corps 19), triangulee par OCCT en
    // motif irregulier ; un « trou » en croissant de 0,5 um de large dans une
    // plaque (corps 0 a 3). On fait donc la soudure NOUS-MEMES, mais en sachant
    // ce qu'on soude : chaque amas de sommets distincts a moins de kMicro est
    // ramene a son barycentre, puis on nettoie ce que la fusion a fabrique —
    // triangles degeneres retires, doublons stricts dedoublonnes, et paires de
    // triangles opposes NEES DE LA FUSION annulees (la paroi d'epaisseur nulle
    // qu'est devenue une fente de 0,5 um). Les paires opposees preexistantes ne
    // sont pas touchees, conformement a la regle de l'etage C.
    {
        const double sc = std::fabs(instLoc.Transformation().ScaleFactor());
        const double kMicro = 0.002 / (sc > 0.0 ? sc : 1.0);
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        std::vector<char> live(vertsOut, 0);
        for (uint32_t t = 0; t < ntri; ++t)
            if (!triDead[t]) for (int k = 0; k < 3; ++k) live[md.indices[t*3+k]] = 1;
        for (uint32_t v = 0; v < vertsOut; ++v) if (nmVert[v]) live[v] = 0;
        // Grille de pas kMicro en table a adressage ouvert (tete de liste par
        // cellule + chainage des sommets) : aucune allocation par cellule, et
        // seulement la moitie des voisines (13 + la sienne), la relation etant
        // symetrique. Sur un corps sain, c'est le seul cout de cette passe.
        auto cell = [&](double x) { return (int64_t)std::floor(x / kMicro); };
        auto ckey = [](int64_t i, int64_t j, int64_t k) {
            return ((uint64_t)(uint32_t)i * 73856093ull) ^ ((uint64_t)(uint32_t)j * 19349663ull)
                 ^ ((uint64_t)(uint32_t)k * 83492791ull);
        };
        std::vector<int64_t> ci((size_t)vertsOut * 3);
        uint32_t nLive = 0;
        for (uint32_t v = 0; v < vertsOut; ++v) {
            if (!live[v]) continue;
            nLive++;
            for (int k = 0; k < 3; ++k) ci[(size_t)v*3+k] = cell(vp[(size_t)v*3+k]);
        }
        size_t cap = 16;
        while (cap < (size_t)nLive * 2) cap <<= 1;
        std::vector<uint32_t> head(cap, UINT32_MAX), nextV(vertsOut, UINT32_MAX);
        std::vector<int64_t> slotCell(cap * 3);
        auto findSlot = [&](int64_t i, int64_t j, int64_t k, bool insert) -> size_t {
            size_t h = (size_t)ckey(i, j, k) & (cap - 1);
            for (;;) {
                if (head[h] == UINT32_MAX) return insert ? h : SIZE_MAX;
                if (slotCell[h*3] == i && slotCell[h*3+1] == j && slotCell[h*3+2] == k) return h;
                h = (h + 1) & (cap - 1);
            }
        };
        for (uint32_t v = 0; v < vertsOut; ++v) {
            if (!live[v]) continue;
            const size_t h = findSlot(ci[(size_t)v*3], ci[(size_t)v*3+1], ci[(size_t)v*3+2], true);
            if (head[h] == UINT32_MAX) { slotCell[h*3] = ci[(size_t)v*3]; slotCell[h*3+1] = ci[(size_t)v*3+1]; slotCell[h*3+2] = ci[(size_t)v*3+2]; }
            nextV[v] = head[h]; head[h] = v;
        }
        DSU cl(vertsOut);
        bool anyPair = false;
        auto test = [&](uint32_t v, uint32_t w) {
            double d2 = 0;
            for (int k = 0; k < 3; ++k) { const double dd = vp[(size_t)v*3+k] - vp[(size_t)w*3+k]; d2 += dd * dd; }
            if (d2 < kMicro * kMicro) { cl.unite(v, w); anyPair = true; }
        };
        static const int kHalf[13][3] = { {1,0,0}, {-1,1,0}, {0,1,0}, {1,1,0}, {-1,-1,1}, {0,-1,1}, {1,-1,1},
                                          {-1,0,1}, {0,0,1}, {1,0,1}, {-1,1,1}, {0,1,1}, {1,1,1} };
        for (uint32_t v = 0; v < vertsOut; ++v) {
            if (!live[v]) continue;
            const int64_t i = ci[(size_t)v*3], j = ci[(size_t)v*3+1], k = ci[(size_t)v*3+2];
            for (uint32_t w = nextV[v]; w != UINT32_MAX; w = nextV[w]) test(v, w);   // meme cellule
            for (const auto& o : kHalf) {
                const size_t h = findSlot(i + o[0], j + o[1], k + o[2], false);
                if (h == SIZE_MAX) continue;
                for (uint32_t w = head[h]; w != UINT32_MAX; w = nextV[w]) test(v, w);
            }
        }
        if (anyPair) {
            // Barycentre de chaque amas, porte par sa racine.
            std::vector<double> acc((size_t)vertsOut * 3, 0.0);
            std::vector<uint32_t> cnt(vertsOut, 0);
            for (uint32_t v = 0; v < vertsOut; ++v) {
                if (!live[v]) continue;
                const uint32_t r = cl.find(v);
                for (int k = 0; k < 3; ++k) acc[(size_t)r*3+k] += vp[(size_t)v*3+k];
                cnt[r]++;
            }
            // On ne fusionne que ce que la soudure du client rendrait non manifold.
            // Deux sommets sans voisin commun, meme soudes, ne font qu'un sommet
            // pince : aucune arete n'y gagne de triangle, le controle de NASSCAD
            // reste vert — on les laisse distincts (maillage plus propre pour le CSG).
            // Seuls les amas qui, fusionnes comme le ferait le client, donneraient
            // une arete a plus de deux triangles sont fusionnes ici.
            std::vector<char> merged(vertsOut, 0);
            {
                std::unordered_map<uint64_t, int> ec;
                ec.reserve((size_t)ntri * 3);
                for (uint32_t t = 0; t < ntri; ++t) {
                    if (triDead[t]) continue;
                    uint32_t r[3];
                    for (int k = 0; k < 3; ++k) {
                        const uint32_t v = md.indices[t*3+k];
                        r[k] = (live[v] && cnt[cl.find(v)] >= 2) ? cl.find(v) : v;
                    }
                    if (r[0] == r[1] || r[1] == r[2] || r[2] == r[0]) continue;
                    for (int k = 0; k < 3; ++k) ec[edgeKey(r[k], r[(k+1)%3])]++;
                }
                for (const auto& kv : ec) {
                    if (kv.second <= 2) continue;
                    const uint32_t a = (uint32_t)(kv.first >> 32), b = (uint32_t)(kv.first & 0xFFFFFFFFu);
                    if (a < vertsOut && cnt[a] >= 2) merged[a] = 1;
                    if (b < vertsOut && cnt[b] >= 2) merged[b] = 1;
                }
            }
            for (uint32_t r = 0; r < vertsOut; ++r)
                if (merged[r]) {
                    for (int k = 0; k < 3; ++k) vp[(size_t)r*3+k] = acc[(size_t)r*3+k] / cnt[r];
                    touchedV[r] = 1;
                    diag.microClusters++;
                }
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                for (int k = 0; k < 3; ++k) {
                    const uint32_t v = md.indices[t*3+k];
                    const uint32_t r = (live[v] && merged[cl.find(v)]) ? cl.find(v) : v;
                    if (r != v) md.indices[t*3+k] = r;
                }
                const uint32_t a = md.indices[t*3], b = md.indices[t*3+1], c = md.indices[t*3+2];
                if (a == b || b == c || c == a) { triDead[t] = 1; diag.trisDegen++; }
            }
        }
    }

    // [FIX 27/09] Nettoyage de ce que contractions et fusions ont fabrique, et de
    // cela SEUL (triangles portant un sommet deplace) : doublons stricts,
    // paires de triangles opposes, quadrilateres opposes.
    auto cleanupTouched = [&]() {
      if (std::find(touchedV.begin(), touchedV.end(), (char)1) != touchedV.end()) {
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        {
            std::unordered_map<TriKey, std::vector<uint32_t>, TriKeyHash> byKey;
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                const uint32_t a = md.indices[t*3], b = md.indices[t*3+1], c = md.indices[t*3+2];
                if (!touchedV[a] && !touchedV[b] && !touchedV[c]) continue;
                bool opp = false;
                byKey[canon(a, b, c, opp)].push_back(t);
            }
            for (auto& kv : byKey) {
                if (kv.second.size() < 2) continue;
                std::vector<uint32_t> fw, bw;
                for (uint32_t t : kv.second) {
                    bool opp = false;
                    canon(md.indices[t*3], md.indices[t*3+1], md.indices[t*3+2], opp);
                    (opp ? bw : fw).push_back(t);
                }
                while (!fw.empty() && !bw.empty()) {   // paroi d'epaisseur nulle : on l'annule
                    triDead[fw.back()] = triDead[bw.back()] = 1;
                    fw.pop_back(); bw.pop_back();
                    diag.trisCancelled += 2;
                }
                for (size_t i = 1; i < fw.size(); ++i) { triDead[fw[i]] = 1; diag.trisDup++; }
                for (size_t i = 1; i < bw.size(); ++i) { triDead[bw[i]] = 1; diag.trisDup++; }
            }
            // Meme paroi, autre decoupe : les deux flancs de la fente devenus
            // confondus couvrent le MEME quadrilatere (memes quatre sommets, sens
            // opposes), mais chaque face l'a coupe par une diagonale differente —
            // aucun triangle n'en double un autre. On compare donc les
            // quadrilateres (deux triangles d'une meme face partageant une arete),
            // cycle canonique compris, et on annule les deux s'ils sont opposes.
            struct Quad { uint32_t t1, t2, slot; bool rev; };
            std::map<std::array<uint32_t, 4>, std::vector<Quad>> quads;
            std::unordered_map<uint64_t, std::vector<uint32_t>> et;
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                bool touched = false;
                for (int k = 0; k < 3; ++k) if (touchedV[md.indices[t*3+k]]) touched = true;
                if (!touched) continue;
                for (int k = 0; k < 3; ++k) et[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])].push_back(t);
            }
            for (const auto& kv : et) {
                if (kv.second.size() < 2) continue;
                for (size_t i = 0; i < kv.second.size(); ++i)
                    for (size_t j = i + 1; j < kv.second.size(); ++j) {
                        const uint32_t t = kv.second[i], u = kv.second[j];
                        if (triSlot[t] != triSlot[u]) continue;
                        // t = (x, y, z) parcourt x -> y ; u doit parcourir y -> x.
                        uint32_t x = 0, y = 0, z = 0, w = UINT32_MAX;
                        for (int k = 0; k < 3; ++k)
                            if (edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3]) == kv.first) {
                                x = md.indices[t*3+k]; y = md.indices[t*3+(k+1)%3]; z = md.indices[t*3+(k+2)%3];
                            }
                        for (int k = 0; k < 3; ++k)
                            if (md.indices[u*3+k] == y && md.indices[u*3+(k+1)%3] == x) w = md.indices[u*3+(k+2)%3];
                        if (w == UINT32_MAX || w == z) continue;
                        // Contour du quadrilatere : z -> x -> w -> y. Forme canonique :
                        // plus petit sommet en tete, et le sens.
                        std::array<uint32_t, 4> cyc = { z, x, w, y };
                        const size_t m = (size_t)(std::min_element(cyc.begin(), cyc.end()) - cyc.begin());
                        std::rotate(cyc.begin(), cyc.begin() + (std::ptrdiff_t)m, cyc.end());
                        const bool rev = cyc[1] > cyc[3];
                        if (rev) std::swap(cyc[1], cyc[3]);
                        quads[cyc].push_back(Quad{ t, u, triSlot[t], rev });
                    }
            }
            for (auto& kv : quads) {
                std::vector<Quad>& q = kv.second;
                for (size_t i = 0; i < q.size(); ++i)
                    for (size_t j = i + 1; j < q.size(); ++j) {
                        if (q[i].slot == q[j].slot || q[i].rev == q[j].rev) continue;
                        if (triDead[q[i].t1] || triDead[q[i].t2] || triDead[q[j].t1] || triDead[q[j].t2]) continue;
                        triDead[q[i].t1] = triDead[q[i].t2] = triDead[q[j].t1] = triDead[q[j].t2] = 1;
                        diag.trisCancelled += 4;
                    }
            }
        }
    }
    };
    cleanupTouched();

    // [FIX 27/09] DIAGONALE COMMUNE A DEUX FACES. KR600, corps 17 : deux faces
    // qui se rejoignent en lame au meme sommet ont chacune coupe leur coin par
    // le MEME triangle (1, 53, 79) — chaque triangulation est juste, mais la
    // diagonale 1-53 porte alors quatre triangles, deux par face. Ni la couture
    // ni la tolerance n'y sont pour rien : c'est un choix de diagonale. On le
    // refait dans UNE des deux faces : les deux triangles de cette face sur
    // l'arete forment un quadrilatere (a, d, b, c) ; on les remplace par
    // (c, a, d) et (d, b, c), memes sommets, meme sens de parcours, meme face,
    // meme place dans le tampon d'index — les plages de couleur par face ne
    // bougent pas. Refuse si la nouvelle diagonale existe deja, ou si l'un des
    // deux triangles se retournerait de plus de 5 % de l'aire du quadrilatere :
    // au coin d'une lame, les deux faces ne laissent qu'un quadrilatere a peine
    // concave, et l'un des deux nouveaux triangles est une lamelle d'aire
    // quasi nulle (mesure KR600 : -6,5 contre +4 779, 0,14 %). On retient la
    // face ou le basculement est le moins penalisant.
    auto flipPass = [&]() {
        std::unordered_map<uint64_t, std::vector<uint32_t>> et;
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        bool any = false;
        {
            std::unordered_map<uint64_t, int> ec;
            ec.reserve((size_t)ntri * 3);
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                for (int k = 0; k < 3; ++k)
                    if (++ec[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])] > 2) any = true;
            }
        }
        if (any) {
            et.reserve((size_t)ntri * 3);
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                for (int k = 0; k < 3; ++k) et[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])].push_back(t);
            }
            auto P = [&](uint32_t w) { return gp_Vec(vp[(size_t)w*3], vp[(size_t)w*3+1], vp[(size_t)w*3+2]); };
            auto nrm = [&](uint32_t a, uint32_t b, uint32_t c) { return (P(b) - P(a)).Crossed(P(c) - P(a)); };
            auto drop = [&](uint64_t ek, uint32_t t) {
                auto it = et.find(ek);
                if (it == et.end()) return;
                auto& l = it->second;
                l.erase(std::remove(l.begin(), l.end(), t), l.end());
            };
            std::vector<uint64_t> over;
            for (const auto& kv : et) if (kv.second.size() > 2) over.push_back(kv.first);
            for (uint64_t ek : over) {
                const uint32_t a = (uint32_t)(ek >> 32), b = (uint32_t)(ek & 0xFFFFFFFFu);
                for (int attempt = 0; attempt < 4 && et[ek].size() > 2; ++attempt) {
                    // Une face qui a exactement deux triangles sur cette arete.
                    std::map<uint32_t, std::vector<uint32_t>> bySlot;
                    for (uint32_t t : et[ek]) bySlot[triSlot[t]].push_back(t);
                    uint32_t bt1 = UINT32_MAX, bt2 = UINT32_MAX, bc = 0, bd = 0;
                    double bestScore = -1e300;
                    for (const auto& sl : bySlot) {
                        if (sl.second.size() != 2) continue;
                        uint32_t t1 = UINT32_MAX, t2 = UINT32_MAX, c = 0, d = 0;
                        for (uint32_t t : sl.second)
                            for (int k = 0; k < 3; ++k) {
                                const uint32_t x = md.indices[t*3+k], y = md.indices[t*3+(k+1)%3], z = md.indices[t*3+(k+2)%3];
                                if (x == a && y == b) { t1 = t; c = z; }
                                if (x == b && y == a) { t2 = t; d = z; }
                            }
                        if (t1 == UINT32_MAX || t2 == UINT32_MAX || c == d) continue;
                        if (et.count(edgeKey(c, d)) && !et[edgeKey(c, d)].empty()) continue;
                        const gp_Vec n0 = nrm(a, b, c) + nrm(b, a, d);
                        const double n2 = n0.SquareMagnitude();
                        if (!(n2 > 0.0)) continue;
                        const double score = std::min(nrm(c, a, d).Dot(n0), nrm(d, b, c).Dot(n0)) / n2;
                        if (score < -0.05 || score <= bestScore) continue;
                        bestScore = score; bt1 = t1; bt2 = t2; bc = c; bd = d;
                    }
                    if (bt1 == UINT32_MAX) break;
                    for (uint32_t t : { bt1, bt2 })
                        for (int k = 0; k < 3; ++k) drop(edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3]), t);
                    md.indices[bt1*3] = bc; md.indices[bt1*3+1] = a;  md.indices[bt1*3+2] = bd;
                    md.indices[bt2*3] = bd; md.indices[bt2*3+1] = b;  md.indices[bt2*3+2] = bc;
                    for (uint32_t t : { bt1, bt2 })
                        for (int k = 0; k < 3; ++k) et[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])].push_back(t);
                    diag.diagFlips++;
                }
            }
        }
    };
    // [FIX 27/09] Sur un corps sain, un seul comptage decide qu'il n'y a rien a
    // basculer ni a contracter.
    bool overLeft = false;
    {
        std::unordered_map<uint64_t, int> ec;
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        ec.reserve((size_t)ntri * 3);
        for (uint32_t t = 0; t < ntri && !overLeft; ++t) {
            if (triDead[t]) continue;
            for (int k = 0; k < 3; ++k)
                if (++ec[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])] > 2) overLeft = true;
        }
    }
    if (overLeft) flipPass();

    // [FIX 27/09] SOUS LA DEFLEXION DE LA PIECE. Ce qui reste a plus de deux
    // triangles apres tout cela est une arete courte qui porte une geometrie plus
    // fine que ce que le maillage sait representer : la pointe de revolution
    // d'une broche de 1,3 mm (support de piles 4xAAA, bibliotheque FreeCAD),
    // rayon sous le micron sur plusieurs microns — a cette resolution, une ligne.
    // Toute soudure au micron (celle du controle de NASSCAD comprise) en fait une
    // « reliure » : une arete de 7 um portee par dix triangles. Meme famille :
    // une arete de 3 um interieure a DEUX faces B-spline (DCMotorEncoder). On
    // contracte donc ces aretes-la, et elles seules (defaut constate, pas de
    // recherche), tant qu'elles sont plus courtes que la deflexion du corps — en
    // dessous, une arete n'est pas une information : le maillage lui-meme ne
    // garantit rien plus fin — et que 0,02 mm, pour qu'un gros corps a grosse
    // deflexion ne perde jamais une arete visible. Puis nettoyage et bascule,
    // comme apres les fusions. Quatre tours au plus.
    if (overLeft) {
        const double sc = std::fabs(instLoc.Transformation().ScaleFactor());
        const double kMax = std::min(bodyDefl, 0.02 / (sc > 0.0 ? sc : 1.0));
        const uint32_t ntri = (uint32_t)(md.indices.size() / 3);
        for (int round = 0; round < 4 && kMax > 0.0; ++round) {
            std::unordered_map<uint64_t, int> ec;
            ec.reserve((size_t)ntri * 3);
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                for (int k = 0; k < 3; ++k) ec[edgeKey(md.indices[t*3+k], md.indices[t*3+(k+1)%3])]++;
            }
            std::vector<std::pair<double, uint64_t>> bad;
            for (const auto& kv : ec) {
                if (kv.second <= 2) continue;
                const uint32_t a = (uint32_t)(kv.first >> 32), b = (uint32_t)(kv.first & 0xFFFFFFFFu);
                if (nmVert[a] || nmVert[b]) continue;          // recouvrement DECLARE : on n'y touche pas
                double d2 = 0;
                for (int k = 0; k < 3; ++k) { const double dd = vp[(size_t)a*3+k] - vp[(size_t)b*3+k]; d2 += dd * dd; }
                if (d2 < kMax * kMax) bad.push_back({ d2, kv.first });
            }
            if (bad.empty()) break;
            std::sort(bad.begin(), bad.end());
            std::vector<uint32_t> to(vertsOut);
            for (uint32_t v = 0; v < vertsOut; ++v) to[v] = v;
            auto R = [&](uint32_t v) { while (to[v] != v) { to[v] = to[to[v]]; v = to[v]; } return v; };
            for (const auto& be : bad) {
                const uint32_t a = R((uint32_t)(be.second >> 32)), b = R((uint32_t)(be.second & 0xFFFFFFFFu));
                if (a == b) continue;
                for (int k = 0; k < 3; ++k) vp[(size_t)a*3+k] = 0.5 * (vp[(size_t)a*3+k] + vp[(size_t)b*3+k]);
                to[b] = a;
                touchedV[a] = 1;
                diag.shortCollapsed++;
            }
            for (uint32_t t = 0; t < ntri; ++t) {
                if (triDead[t]) continue;
                for (int k = 0; k < 3; ++k) md.indices[t*3+k] = R(md.indices[t*3+k]);
                const uint32_t a = md.indices[t*3], b = md.indices[t*3+1], c = md.indices[t*3+2];
                if (a == b || b == c || c == a) { triDead[t] = 1; diag.trisDegen++; }
            }
            cleanupTouched();
            flipPass();
        }
    }

    // [FIX 27/09] Compactage : triangles contractes retires (l'ordre des autres
    // ne bouge pas), sommets non references retires, positions ecrites dans le
    // repere de l'instance, plages de couleur recalculees face par face — une
    // plage par face, dans l'ordre des faces, exactement comme avant.
    {
        std::vector<uint32_t> idx, slotOf;
        idx.reserve(md.indices.size());
        slotOf.reserve(triSlot.size());
        std::vector<uint32_t> nid(vertsOut, UINT32_MAX);
        uint32_t nv = 0;
        for (size_t t = 0; t < triSlot.size(); ++t) {
            if (triDead[t]) continue;
            for (int k = 0; k < 3; ++k) {
                uint32_t& w = nid[md.indices[t*3+k]];
                if (w == UINT32_MAX) w = nv++;
            }
        }
        // Ordre des sommets conserve (croissant), comme sans compactage.
        nv = 0;
        for (uint32_t v = 0; v < vertsOut; ++v) if (nid[v] != UINT32_MAX) nid[v] = nv++;
        for (size_t t = 0; t < triSlot.size(); ++t) {
            if (triDead[t]) continue;
            for (int k = 0; k < 3; ++k) idx.push_back(nid[md.indices[t*3+k]]);
            slotOf.push_back(triSlot[t]);
        }
        md.indices.swap(idx);
        md.positions.resize((size_t)nv * 3);
        const gp_Trsf& itr = instLoc.Transformation();
        for (uint32_t v = 0; v < vertsOut; ++v) {
            if (nid[v] == UINT32_MAX) continue;
            gp_Pnt p(vp[(size_t)v*3], vp[(size_t)v*3+1], vp[(size_t)v*3+2]);
            p.Transform(itr);
            const size_t w = (size_t)nid[v] * 3;
            md.positions[w]   = (float)p.X();
            md.positions[w+1] = (float)p.Y();
            md.positions[w+2] = (float)p.Z();
        }
        vertsOut = nv;
        if (faceColors) {
            for (size_t t = 0; t < slotOf.size(); ) {
                size_t e = t;
                while (e < slotOf.size() && slotOf[e] == slotOf[t]) ++e;
                const FaceRGB& c = slotCol[slotOf[t]];
                runs.push_back(Run{ colorKey(c.r, c.g, c.b, c.a), c.r, c.g, c.b,
                                    (uint32_t)(t * 3), (uint32_t)((e - t) * 3), c.a });
                t = e;
            }
        }
    }

    if (runs.size() > 1) {
        bool multi = false;
        for (size_t i = 1; i < runs.size() && !multi; ++i)
            if (runs[i].key != runs[0].key) multi = true;
        if (multi) {
            md.faces.reserve(runs.size());
            for (const Run& rn : runs)
                md.faces.push_back(MeshData::FaceRange{ rn.r, rn.g, rn.b, rn.start, rn.count, rn.a });
        }
    }

    diag.vertsOut = vertsOut;
    analyzeTopology(md.indices, vertsOut, diag.nakedEdges, diag.overValenced, diag.bowtieVerts);

    gWeldBodies.fetch_add(1);
    if (diag.watertight()) gWeldWatertight.fetch_add(1);
    gWeldEdgesTopo.fetch_add(diag.edgesTopo);
    gWeldEdgesResidual.fetch_add(diag.edgesResidual);
    gWeldEdgesMismatch.fetch_add(diag.edgesMismatch);
    gWeldTrisDropped.fetch_add(diag.trisDegen + diag.trisDup);
    gWeldFacesFilled.fetch_add(diag.facesFilled + diag.facesRedone);
    gWeldDiagFlips.fetch_add(diag.diagFlips);
    // Au journal : tout corps encore defectueux, ET tout corps qui n'a ete sauve
    // que par l'etage geometrique — c'est la liste des prototypes a regarder.
    if (!diag.watertight() || diag.edgesResidual || diag.edgesMismatch
        || diag.edgesOverUsed || diag.edgesSeamOnly
        // [FIX 27/09] et tout corps que les nouveaux etages ont du reprendre
        || diag.edgesNmPaired || diag.facesFilled || diag.facesRedone
        || diag.facesCollapsed || diag.facesUnfilled || diag.diagFlips || diag.microCollapsed || diag.microClusters
        || diag.shortCollapsed) {
        if (!diag.watertight()) gManifoldIssueCount++;
        std::ostringstream oss;
        oss << "[WELD] \"" << name.substr(0, 48) << "\" " << diag.brief() << "\n";
        logFileOnly(oss.str());
    }

    {
        std::unordered_map<const void*, int> val;
        for (const FaceSlot& sl : slots)
            for (TopExp_Explorer ee(sl.face, TopAbs_EDGE); ee.More(); ee.Next()) {
                const TopAbs_Orientation o = ee.Current().Orientation();
                if (o == TopAbs_INTERNAL || o == TopAbs_EXTERNAL) continue;
                if (BRep_Tool::Degenerated(TopoDS::Edge(ee.Current()))) continue;
                val[ee.Current().TShape().get()]++;
            }
        int freeE = 0, nmE = 0;
        for (const auto& kv : val) { if (kv.second == 1) freeE++; else if (kv.second > 2) nmE++; }
        md.brep = nmE ? "nonmanifold" : (freeE ? "open" : "closed");
    }

    if (!md.positions.empty() && !md.indices.empty()) out.push_back(std::move(md));
    return faceCount;
}

// Point d'entree inchange pour les appelants. NASSCAD_TOPOWELD=0 rebascule sur
// l'ancien chemin sans recompiler ; un corps que la couture ne sait pas traiter
// y retombe tout seul.
static int extractInto(const TopoDS_Shape& shape, const std::string& name,
                       std::optional<Quantity_Color> color,
                       std::vector<MeshData>& out,
                       const FaceColorMap* faceColors = nullptr,
                       float alpha = 1.0f) {
    if (topoWeldEnabled()) {
        const size_t before = out.size();
        bool usable = false;
        int faces = 0;
        try {
            faces = extractIntoTopo(shape, name, color, out, faceColors, alpha, usable);
        } catch (const std::exception& e) {
            // Ne jamais perdre un corps sur un incident de couture : on remet le
            // tampon dans l'etat ou on l'a trouve et on repasse par le chemin
            // eprouve. L'incident part au journal, pas a l'ecran.
            out.resize(before);
            usable = false;
            std::ostringstream oss;
            oss << "[WELD] \"" << name.substr(0, 48) << "\" seam welding abandoned ("
                << e.what() << ") — falling back to extractIntoLegacy\n";
            logFileOnly(oss.str());
        } catch (...) {
            // [FIX 27/09] Standard_Failure (OCCT) ne derive pas de std::exception :
            // sans ce filet, une exception OCCT levee pendant la couture remontait
            // jusqu'au pool de threads et faisait echouer l'import ENTIER.
            out.resize(before);
            usable = false;
            logFileOnly("[WELD] \"" + name.substr(0, 48) + "\" seam welding abandoned (OCCT exception)"
                        " — falling back to extractIntoLegacy\n");
        }
        if (usable) return faces;
        out.resize(before);
        gWeldFallback.fetch_add(1);
    }
    return extractIntoLegacy(shape, name, color, out, faceColors, alpha);
}

// JSON minimal (échappement suffisant pour des noms de pièces STEP — pas de contrôle
// arbitraire attendu ici, entrée = notre propre pipeline OCCT, pas du texte utilisateur libre).
static std::string jsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) { /* skip control chars */ }
                else o += c;
        }
    }
    return o;
}

// Barre de progression sur PLACE : retour chariot (\r) qui reecrit la meme
// ligne — technique "console classique" (celle demandee explicitement par
// Nass, cf. capture d'exemple [████...] 67%), PAS d'ANSI (ESC[1A/ESC[2K).
// [15/08 FIX v2] Remplace l'ancienne version a base d'echappements ANSI :
// ceux-ci supposent ENABLE_VIRTUAL_TERMINAL_PROCESSING actif cote console,
// jamais active ici (ce binaire est un ELF WSL, la console Windows n'est
// qu'un relais — impossible d'appeler l'API Win32 SetConsoleMode depuis ce
// process) ; en conhost.exe classique (fenetre wsl.exe, PAS Windows Terminal
// — cf. capture d'ecran de Nass) rien ne garantissait que ces sequences
// soient interpretees. \r est un controle bien plus ancien et
// universellement supporte, meme par un relais non-VT100.
// Chaque frame se termine par \r (PAS \n) et flush explicitement : la ligne
// reste "ouverte" (gBarActive=true) jusqu'a ce que barPhaseStart() la valide
// avec un vrai saut de ligne, OU qu'un log normal s'intercale — dans ce cas
// TeeStreambuf::flushBuffer ferme desormais automatiquement la ligne AVANT de
// laisser passer ce log (voir plus bas), au lieu de l'ancienne suppression
// caractere par caractere qui ne laissait passer que le \n final de chaque
// ligne supprimee -> defilement de lignes vides (la cause du bug signale par
// Nass : "tu as casse l'affichage de la console").
// [15/08 FIX v7] Largeur reduite de 40 -> 24 : libere de la place pour le
// texte (nom de piece + compteurs REPAIR/MANIFOLD-RAW) dans le budget de
// longueur de ligne desormais impose par drawBarLine (cf. son commentaire).
// [28/08] Blocs pleins facon barre de progression DOS : U+2588 FULL BLOCK pour
// le rempli, U+2591 LIGHT SHADE pour le vide (les deux etaient deja la en
// CP437 : 219 et 176 — c'est litteralement la barre des installeurs DOS).
// La console est passee en CP_UTF8 au demarrage (SetConsoleOutputCP), donc
// l'UTF-8 sort tel quel ; il faut juste une police TrueType (Consolas, Lucida),
// ce qui est le defaut de cmd.exe et de Windows Terminal depuis longtemps.
//
// ATTENTION, PIEGE : ces deux caracteres font 3 OCTETS chacun en UTF-8. Tout le
// calcul de longueur de drawBarLine (cap a 78, padding d'effacement) etait en
// octets ; laisse tel quel, une barre de 24 blocs compterait pour 72 et se
// ferait tronquer immediatement. D'ou consoleCols/consoleTruncate juste en
// dessous, et gLastBarLen qui compte desormais des COLONNES, pas des octets.
static const char* BAR_FILL  = "\xE2\x96\x88"; // U+2588 FULL BLOCK
static const char* BAR_EMPTY = "\xE2\x96\x91"; // U+2591 LIGHT SHADE
static std::string renderBar(double frac, int width = 24) {
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    int filled = (int)(frac * width + 0.5);
    std::string bar = "[";
    for (int i = 0; i < width; i++) bar += (i < filled) ? BAR_FILL : BAR_EMPTY;
    bar += "]";
    return bar;
}

// Largeur d'affichage en colonnes = nombre de points de code UTF-8. On compte
// les octets qui ne sont PAS des continuations (10xxxxxx). Suffisant ici :
// tout ce qui transite par la barre est en largeur 1 (ASCII + blocs U+258x).
static size_t consoleCols(const std::string& s) {
    size_t n = 0;
    for (unsigned char c : s) if ((c & 0xC0) != 0x80) n++;
    return n;
}
// Troncature a maxCols COLONNES, jamais au milieu d'une sequence UTF-8 — un
// substr() brut sur des octets couperait un bloc en deux et enverrait un octet
// isole a la console, qui l'afficherait en caractere de remplacement.
static std::string consoleTruncate(const std::string& s, size_t maxCols) {
    size_t cols = 0, i = 0;
    while (i < s.size()) {
        size_t start = i;
        i++;
        while (i < s.size() && ((unsigned char)s[i] & 0xC0) == 0x80) i++;
        if (cols + 1 > maxCols) return s.substr(0, start);
        cols++;
    }
    return s;
}
// [14/08] gBarActive — vrai tant qu'une frame de barre est "ouverte" sur la
// console (dernier octet envoye = \r, jamais encore valide par un \n). Mis a
// jour UNIQUEMENT par TeeStreambuf::flushBuffer (plus bas), qui est la seule
// autorite sur ce qui part reellement vers la console.
static bool gBarActive = false;
static size_t gLastBarLen = 0; // largeur (EN COLONNES, pas en octets) de la derniere frame — completee au blanc pour effacer le reliquat (ex: nom de piece plus court que le precedent)
// [24/09] Ce que faisait le moteur a l'instant d'un plantage, pour le rapport
// (crashrep, plus bas) : derniere requete recue, derniere barre dessinee.
// Tampons FIXES : un gestionnaire de plantage ne doit pas allouer. Un verrou
// d'essai suffit — une barre sautee de temps en temps ne manque a personne.
static char gCrashRequest[320] = "(none yet)";
static char gCrashBar[320] = "(none yet)";
static std::atomic_flag gCrashBarBusy = ATOMIC_FLAG_INIT;
static void crashNoteBar(const std::string& label, const std::string& suffix) {
    if (gCrashBarBusy.test_and_set(std::memory_order_acquire)) return;
    std::snprintf(gCrashBar, sizeof gCrashBar, "%s  %s", label.c_str(), suffix.c_str());
    gCrashBarBusy.clear(std::memory_order_release);
}
static void drawBarLine(const std::string& label, double frac, const std::string& suffix) {
    crashNoteBar(label, suffix);
    std::string line = "  " + label + " " + renderBar(frac) + " " + suffix;
    // [15/08 FIX v7] Cap dur de longueur. Une ligne plus longue que la
    // largeur du terminal force un retour a la ligne PHYSIQUE cote
    // affichage ; le \r suivant ne revient alors qu'au debut de CETTE
    // ligne physique (la 2e), pas au debut de la ligne LOGIQUE -> la barre
    // "defile" au lieu de s'ecraser sur place. Repere sur TESSELLATION des
    // que son suffixe s'est allonge (nom de piece + compteur REPAIR/
    // MANIFOLD-RAW, cf. repairManifoldSuffix) : PARSING/RESOLUTION restaient
    // courtes et s'en sortaient, TESSELLATION avec ce nouveau suffixe non.
    // Largeur de fenetre cmd.exe jamais garantie ni interrogeable de facon
    // fiable a travers le relais WSL->conhost -- plutot que parier sur une
    // largeur precise, cap volontairement prudent (80 colonnes = plus petit
    // dénominateur commun d'une fenetre console Windows) et troncature
    // propre avec "..." si depasse.
    // [28/08] Tout ce bloc compte desormais en COLONNES et non en octets — cf.
    // le commentaire de renderBar : depuis les blocs UTF-8, les deux ne sont
    // plus la meme chose. gLastBarLen suit la meme unite.
    static constexpr size_t kMaxLineLen = 78;
    size_t cols = consoleCols(line);
    if (cols > kMaxLineLen) {
        line = consoleTruncate(line, kMaxLineLen - 3) + "...";
        cols = consoleCols(line);
    }
    if (cols < gLastBarLen) { line.append(gLastBarLen - cols, ' '); cols = gLastBarLen; }
    gLastBarLen = cols;
    // [15/08 FIX v3] Le \r DOIT partir dans le MEME appel << que le reste du
    // texte. cerr est unitbuf : chaque appel << individuel se flush a lui
    // tout seul (le sentry se detruit — donc flush — a la fin de CET appel,
    // pas a la fin de toute l'expression chainee). "\r" << line << flush
    // envoyait donc le \r seul comme UN premier paquet, puis line comme un
    // SECOND paquet ne commencant plus par \r -> TeeStreambuf::flushBuffer
    // ne le reconnaissait plus comme une frame de barre (isBarFrame=false
    // pour ce second paquet), le traitait comme un log normal : horodatage
    // ajoute + \n de fermeture injecte avant, donc barre qui defile a
    // chaque frame au lieu de s'ecraser sur place — exactement le symptome
    // observe par Nass. Un seul << avec le \r deja concatene au texte =
    // un seul appel = un seul flush = un seul paquet reconnu par isBarFrame.
    std::cerr << ("\r" + line) << std::flush;
}
static void barPhaseStart() {
    if (gBarActive) std::cerr << "\n" << std::flush; // valide la derniere frame de la phase precedente sur SA propre ligne
    gLastBarLen = 0; // nouvelle phase = pas de reliquat a effacer sur la premiere frame
}

// [15/08 FIX v4] logFileOnly — meme demande que pour PARSING/TESSELLATION,
// etendue a COLOR/REPAIR/MANIFOLD-RAW : ces logs partent UN PAR PIECE
// (potentiellement des milliers), ce qui noyait la console de defilement
// exactement comme le faisait TESSELLATION avant d'avoir sa barre. Plutot
// que d'essayer de faire cohabiter un flot de texte ligne-par-ligne ET une
// barre sur la meme portion de console (les deux se marchent dessus quoi
// qu'on fasse — une nouvelle ligne de texte ferme forcement la frame de
// barre en cours), le detail complet continue d'aller VERS LE FICHIER
// (medusa.log garde tout, rien n'est perdu), et la CONSOLE ne voit plus
// qu'une barre de progression pour ces logs — comme PARSING/TESSELLATION.
//
// Marqueur '\x01' (SOH, jamais present dans du texte normal) en tete du
// message : TeeStreambuf::flushBuffer le reconnait et route TOUT le
// contenu vers le fichier uniquement, sans jamais toucher gBarActive ni la
// console — la barre de la phase en cours continue de s'ecraser sur place,
// totalement indifferente a ces logs.
//
// IMPORTANT (meme piege que drawBarLine, FIX v3) : le message DOIT arriver
// en un seul appel << (une seule chaine deja assemblee), jamais en
// plusieurs << chaines — cerr etant unitbuf, des << separes partiraient en
// paquets separes et seul le premier porterait le marqueur '\x01'.
static void logFileOnly(const std::string& msg) {
    std::cerr << ("\x01" + msg) << std::flush;
}

// [15/08 FIX v5] Petit resume REPAIR/MANIFOLD-RAW greffe dans le suffixe de
// la barre TESSELLATION (cf. les commentaires pres des 3 compteurs) — vide
// tant qu'aucun des deux ne s'est produit, pour ne pas polluer le cas normal
// (99%+ des pieces n'ont ni l'un ni l'autre).
// [15/08 FIX v7] Format compacte ("R:" / "M:" plutot que "N reparee(s)" /
// "N non-manifold") — le format verbeux d'origine, cumule a un nom de piece,
// depassait la largeur de ligne desormais imposee par drawBarLine et faisait
// a nouveau defiler la barre (cf. son commentaire).
static std::string repairManifoldSuffix() {
    int rep = gRepairedCount.load() + gPartialRepairCount.load();
    int mf = gManifoldIssueCount.load();
    std::string s;
    if (rep > 0) s += " R:" + std::to_string(rep);
    if (mf > 0) s += " M:" + std::to_string(mf);
    return s;
}

// Construit le buffer NSTP v1 complet à partir des meshes extraits.
static std::string gMetaJson; // rempli par processStepBuffer, consomme ici (mono-thread)
static std::vector<uint8_t> encodeNSTP(const std::vector<MeshData>& meshes, double totalMs) {
    barPhaseStart(); // la barre STEP->NSTP demarre sur SA propre ligne, sous celle de tessellation
    std::ostringstream json;
    json << "{\"success\":true,\"source\":\"nasscad-medusa-engine/3.1\","
         << (gMetaJson.empty() ? "" : ("\"metadata\":" + gMetaJson + ","))
         << "\"meshCount\":" << meshes.size() << ",\"tessMs\":" << totalMs << ",\"meshes\":[";

    uint32_t binLen = 0;
    std::vector<std::pair<const float*, size_t>> posRefs;   // (ptr, count floats)
    std::vector<std::pair<const uint32_t*, size_t>> idxRefs; // (ptr, count uint32)

    for (size_t i = 0; i < meshes.size(); i++) {
        const auto& m = meshes[i];
        uint32_t posOffset = binLen;
        uint32_t posBytes = (uint32_t)(m.positions.size() * sizeof(float));
        binLen += posBytes;
        uint32_t idxOffset = binLen;
        uint32_t idxBytes = (uint32_t)(m.indices.size() * sizeof(uint32_t));
        binLen += idxBytes;

        if (i) json << ",";
        json << "{\"name\":\"" << jsonEscape(m.name) << "\",";
        if (!m.ref.empty()) json << "\"ref\":\"" << jsonEscape(m.ref) << "\",";
        if (m.hasColor) {
            // step-import.js applique la couleur via mColor.r/.g/.b (objet, cf. ligne ~2244
            // du host : "if(mColor && mColor.r !== undefined)") — PAS un tableau [r,g,b].
            // Format aligné sur la sortie native occt-import-js, pas sur l'ancien _nstpEncode
            // JS (cache IDB) qui encodait en tableau — incohérence pré-existante côté cache,
            // sans impact ici puisqu'on écrit notre propre encodeur.
            // [18/09] "a" (opacite) n'est ecrit QUE s'il y a vraiment de la
            // transparence : un modele opaque produit octet pour octet le meme
            // JSON qu'avant, et un client anterieur ignore simplement ce champ.
            json << "\"color\":{\"r\":" << m.r << ",\"g\":" << m.g << ",\"b\":" << m.b;
            if (m.a < 1.0f) json << ",\"a\":" << m.a;
            json << "},";
        } else {
            json << "\"color\":null,";
        }
        // [27/08] Champ ADDITIF, absent quand le solide est monochrome : un client
        // anterieur a cette version le voit exactement comme avant. Une entree par
        // face topologique, dans l'ordre du TopExp_Explorer — l'indice dans ce
        // tableau EST le numero de face, ce qui rendra la selection par face
        // possible. Forme compacte [r,g,b,start,count] plutot qu'un objet : sur un
        // corps a quelques milliers de faces, la difference de taille JSON est
        // d'un facteur deux.
        if (!m.faces.empty()) {
            json << "\"faces\":[";
            for (size_t g = 0; g < m.faces.size(); g++) {
                if (g) json << ",";
                // 6e element optionnel = opacite de la face. Absent quand elle
                // est opaque : la forme [r,g,b,start,count] reste la norme, et le
                // client lit par indice, donc il ignore ce qu'il ne connait pas.
                json << "[" << m.faces[g].r << "," << m.faces[g].g << "," << m.faces[g].b
                     << "," << m.faces[g].start << "," << m.faces[g].count;
                if (m.faces[g].a < 1.0f) json << "," << m.faces[g].a;
                json << "]";
            }
            json << "],";
        }
        if (!m.brep.empty()) json << "\"brep\":\"" << m.brep << "\",";   // [FIX 27/09] champ ADDITIF
        json << "\"posOffset\":" << posOffset << ",\"posCount\":" << m.positions.size()
             << ",\"idxOffset\":" << idxOffset << ",\"idxCount\":" << m.indices.size() << "}";

        {
            int pct = (int)(100.0 * (i + 1) / meshes.size());
            int prevPct = (int)(100.0 * i / meshes.size());
            if (pct != prevPct || i + 1 == meshes.size()) {
                drawBarLine("STEP -> NSTP",
                    (double)(i + 1) / meshes.size(),
                    std::to_string(pct) + "%  (" + std::to_string(i + 1) + "/" + std::to_string(meshes.size()) + ")");
            }
        }

        posRefs.push_back({ m.positions.data(), m.positions.size() });
        idxRefs.push_back({ m.indices.data(), m.indices.size() });
    }
    json << "]}";

    std::string jsonStr = json.str();
    // Padding à un multiple de 4 avec des espaces (0x20), comme l'encodeur JS de référence.
    size_t pad = (4 - (jsonStr.size() % 4)) % 4;
    jsonStr.append(pad, ' ');

    uint32_t jsonLen = (uint32_t)jsonStr.size();
    std::vector<uint8_t> out(16 + jsonLen + binLen);
    out[0] = 'N'; out[1] = 'S'; out[2] = 'T'; out[3] = 'P';
    auto writeU32LE = [&](size_t off, uint32_t v) {
        out[off+0] = (uint8_t)(v & 0xFF);
        out[off+1] = (uint8_t)((v >> 8) & 0xFF);
        out[off+2] = (uint8_t)((v >> 16) & 0xFF);
        out[off+3] = (uint8_t)((v >> 24) & 0xFF);
    };
    writeU32LE(4, 1);
    writeU32LE(8, jsonLen);
    writeU32LE(12, binLen);
    std::memcpy(out.data() + 16, jsonStr.data(), jsonLen);

    size_t off = 16 + jsonLen;
    for (size_t i = 0; i < meshes.size(); i++) {
        std::memcpy(out.data() + off, posRefs[i].first, posRefs[i].second * sizeof(float));
        off += posRefs[i].second * sizeof(float);
        std::memcpy(out.data() + off, idxRefs[i].first, idxRefs[i].second * sizeof(uint32_t));
        off += idxRefs[i].second * sizeof(uint32_t);
    }

    return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Récursion dans l'arbre d'assemblage XCAF : GetFreeShapes() ne renvoie que
// les racines (ex: 1 seul assemblage englobant, jamais les 198 composants
// feuilles). Il faut descendre à travers assemblages/sous-assemblages en
// composant les TopLoc_Location à chaque niveau (chaque instance porte SA
// propre position relative à son parent immédiat, pas la position globale).
// ─────────────────────────────────────────────────────────────────────────
static Handle(XCAFDoc_ColorTool) gColorTool;
// [13/08] gShapeTool ajoute — necessaire pour FindSubShape (methode d'INSTANCE,
// pas statique, verifie dans le vrai header XCAFDoc_ShapeTool.hxx avant d'ecrire
// cette ligne). Sert a resoudre la couleur d'un sous-solide par LABEL explicite
// plutot que par hash de forme (GetColor(TopoDS_Shape) direct) — ce dernier
// s'est avere retourner la mauvaise couleur pour 620/1297 solides sur
// Scania-Engine-V8-XT-Turbo.step, diagnostique via colPath dans cette meme
// session. Meme fragilite documentee qu'ailleurs (recherche du 13/08 sur
// GetColor casse depuis 7.4.0) — FindSubShape+label evite le hash, comme
// resolvedLabel l'evite deja au niveau du leaf entier.
//
// ══ [31/08] CORRECTION : GetColor(TopoDS_Shape) n'etait pas casse. ═══════════
//
// Le paragraphe ci-dessus reste, c'est l'historique — mais son diagnostic est
// faux, et le croire coute cher : il pousse a contourner un bug d'OCCT qui
// n'existe pas.
//
// Preuve, medusa.log du 31/08 (import Scania complet, 1295 corps). Les 113
// lignes [COLOR-KEPT-LEAF] disent quelle couleur l'etage sous-solide proposait
// avant d'etre ignore. Elles ne contiennent que QUATRE valeurs :
//     67 x #DDDD0D    32 x #5A6266    8 x #BEBCBA    6 x #CB9A3B
// Or la lecture directe du Part21 donne la liste des couleurs que le fichier
// pose au niveau MANIFOLD_SOLID_BREP :
//     #5A6266 (134 corps), #DDDD0D (53), #BEBCBA (38), #CB9A3B (9),
//     #CF4F00 (8), #F4F4F4 (8), #404040 (3), #5A5B5B (1)
// Les quatre valeurs proposees sont toutes, et uniquement, des couleurs de
// niveau SOLIDE. Aucune valeur aberrante, aucune couleur de face, aucune
// couleur empruntee a une autre piece. Un hash mal apparie rendrait n'importe
// quoi ; celui-ci rend exactement ce que le fichier ecrit sur le solide.
//
// Ce qu'on prenait pour une fragilite de GetColor etait donc la BONNE valeur au
// MAUVAIS NIVEAU : ce fichier (Inventor via ST-Developer) pose une couleur sur
// le solide ET des couleurs sur ses faces, et la regle OCCT veut que la face
// gagne (XCAFPrs::CollectStyleSettings : le style d'une sous-forme ecrase celui
// de son parent). C'est corrige en amont depuis le 31/08, dans decideBodyColor().
//
// FindSubShape+label reste utile et reste en place : resoudre par label plutot
// que par hash est plus direct et plus lisible. Mais ce n'est pas un
// contournement de bug, et il ne faut pas le traiter comme tel.
// ════════════════════════════════════════════════════════════════════════════
static Handle(XCAFDoc_ShapeTool) gShapeTool;
// [10/08] Filet de dernier recours par NOM — proposé par Nass après que
// l'heritage d'assemblage (v2.8) se soit revele insuffisant sur des pieces
// lourdement reparees (Orbiter-Extruder). Diagnostic : ligne ~575, la
// resolution par SOLIDE individuel ECRASE sans condition ce que
// leaf.color (v2.8) avait correctement resolu — si cette resolution par
// identite de forme echoue silencieusement sur un solide issu d'un
// remaillage/reparation lourd, l'heritage n'a jamais sa chance de s'exprimer.
// Principe : coupler par NOM plutot que par identite de forme (qui peut se
// briser apres decoupage/reparation), en dernier recours seulement — jamais
// prioritaire sur une resolution par identite reussie. Rempli au fil de
// l'eau (chaque succes alimente la table), consulte seulement a l'echec.
// Sur, meme pour des instances repetees du meme prototype (nom partage) :
// deux instances d'une meme vis M3x6 partagent presque certainement la
// meme couleur reelle, donc reutiliser celle d'une instance-soeur deja
// resolue est correct, pas une approximation hasardeuse.

// [14/08] ConsoleProgress — barre de progression PARSING dans la console
// MEDUSA, distincte de la barre TESSELLATION deja existante par ailleurs.
// Piste ouverte hier : sur un fichier de 1,3 Go (Dante.step), "reading..."
// restait affiche 12+ minutes sans aucun signe d'activite visible — impossible
// de distinguer "ca travaille encore" de "c'est bloque". API verifiee dans le
// vrai header Message_ProgressIndicator.hxx avant d'ecrire cette classe (pas
// de memoire) : Show() est pur virtuel, appele par l'algorithme lui-meme
// pendant Transfer() — throttle par instance (pas static/partage) pour ne
// pas noyer la console a chaque micro-increment.
class ConsoleProgress : public Message_ProgressIndicator {
public:
    virtual void Show(const Message_ProgressScope& theScope, const Standard_Boolean isForce) override {
        double maxV = theScope.MaxValue();
        if (maxV <= 0) return;
        double pct = (theScope.Value() / maxV) * 100.0;
        const char* nm = theScope.Name();
        std::string key = nm ? nm : "STEP";

        // [14/08 FIX v3] isForce retire de la decision — log reel (Voron
        // 2.4r2, 195 000 lignes generees) montre que meme le mute par nom
        // (v2) ne suffisait pas : OCCT appelle Show() avec isForce=true pour
        // chaque micro-completion interne, ce qui contournait le "!isForce"
        // du throttle et laissait TOUT passer. Decision desormais basee
        // uniquement sur pourcentage + nom, jamais sur ce que l'appelant
        // pretend forcer.
        //
        // [FIX AUDIT 18/08] Bug rapporte par Nass : la barre PARSING ne
        // reflete pas la vraie progression sur un gros assemblage. Cause
        // trouvee ici : theScope.Name() est REUTILISE a chaque piece/root
        // transfere(e) (pas un nom unique par piece). L'ancienne regle
        // "si le tout premier echantillon vu pour ce nom est deja >=95%,
        // blacklister ce nom EN PERMANENCE" (myMutedNames) partait d'une
        // bonne intention (ne pas dessiner un evenement deja termine, rien
        // a montrer) mais avait un effet de bord severe : si la toute
        // premiere piece rencontree se transfere quasi instantanement
        // (petite piece simple), son echantillon initial est deja >=95% ->
        // le nom de scope est mute a vie, et TOUTES les pieces suivantes
        // qui reutilisent ce meme nom — y compris des pieces bien plus
        // grosses/lentes sur un gros assemblage — n'apparaissent plus JAMAIS,
        // meme si OCCT continue a reporter une vraie progression 0->100 pour
        // chacune. Resultat : la barre semble figee/muette pendant l'essentiel
        // du travail, exactement le symptome que cette classe visait a
        // l'origine a corriger (cf. commentaire Dante.step plus haut).
        //
        // Nouveau comportement : on saute seulement l'echantillon instantane
        // (rien d'interessant a dessiner CETTE occurrence-la), sans jamais
        // blacklister le nom pour les occurrences futures — et on detecte la
        // REPRISE d'un nom (pct qui redescend sous la derniere valeur dessinee
        // = une nouvelle piece reutilise ce nom de scope depuis le debut) pour
        // ne pas laisser le throttle delta ci-dessous, calibre pour un pourcentage
        // croissant, avaler a tort le debut de cette nouvelle piece parce qu'il
        // le comparerait a l'ancienne fin (souvent 100%) de la piece precedente.
        auto itSeen = mySeenNames.find(key);
        if (itSeen == mySeenNames.end()) {
            mySeenNames.insert(key);
            if (pct >= 95.0) return; // rien a montrer cette fois — le nom reste actif pour la suite
        }

        double& lastForKey = myLastPctByName[key];
        bool isRestart = pct < lastForKey; // meme nom, nouvelle piece repartant de zero
        if (!isRestart) {
            if ((pct - lastForKey) < 2.0 && pct < 100.0) return;
            // Un 100% deja imprime pour ce nom ne se reimprime plus (lastForKey
            // deja a 100 -> diff=0, coupe par la ligne au-dessus) — seul le
            // PREMIER 100% authentique d'une progression legitime passe. Garde
            // explicite ici pour le cas d'egalite exacte.
            if (pct >= 100.0 && lastForKey >= 100.0) return;
        }
        lastForKey = pct;
        // [14/08] \r plutot que \n — reecrit la meme ligne a chaque mise a
        // jour (comme une barre de telechargement classique) plutot que d'en
        // empiler une nouvelle par appel.
        // [14/08 FIX v4] A l'epoque, un \r "nu" (v3, tantot) sans passer par
        // TeeStreambuf avait semble rester bufferise a travers le relais
        // WSL->console — remplace alors par une redraw ANSI (\x1b[1A\x1b[2K).
        // [15/08 FIX v2] Retour au \r EXPLICITEMENT demande par Nass (barre
        // "console classique") apres que l'ANSI se soit revele lui-meme non
        // fiable en conhost.exe classique (pas de ENABLE_VIRTUAL_TERMINAL_
        // PROCESSING, jamais actionnable depuis ce binaire WSL). Cette fois
        // le \r passe PAR drawBarLine -> TeeStreambuf::flushBuffer, avec un
        // std::flush explicite a chaque frame : le probleme de bufferisation
        // de 14/08 n'a jamais ete confirme venir du \r lui-meme plutot que de
        // l'absence de flush a l'epoque. Si la barre PARSING ne s'anime
        // toujours pas en direct malgre ce changement, ce sera un signal fort
        // que le relais WSL->conhost bufferise reellement tout ce qui n'est
        // pas termine par \n, independamment du \r — prochaine etape dans ce
        // cas : revenir a des lignes pleines (\n) mais throttlees, sans
        // pretention a l'ecrasement sur place.
        if (!myPhaseStarted) { barPhaseStart(); myPhaseStarted = true; }
        drawBarLine("PARSING", pct / 100.0, std::to_string((int)pct) + "%  " + key);
    }
private:
    std::unordered_map<std::string, double> myLastPctByName;
    std::unordered_set<std::string> mySeenNames;
    // [FIX AUDIT 18/08] myMutedNames (blacklist permanente par nom) supprime —
    // cf. commentaire dans Show() : cause du bug de barre figee sur gros assemblage.
    bool myPhaseStarted = false;
};

struct LeafShape {
    std::string name;
    std::optional<Quantity_Color> color;
    double deflection = 1.0; // deflection de SA racine (multi-racines : chaque racine a la sienne)
    TopoDS_Shape shape;    // repositionnée dans le repère racine (transform composé appliqué)
    TopoDS_Shape rawShape; // prototype NON déplacé — SEULE forme que le ColorTool sait
                           // retrouver (il indexe par shape+location d'origine ; Moved()
                           // casse la correspondance — vérifié empiriquement : 106/198
                           // via shape déplacée, 198/198 via prototype)
    // [27/08] Carte face -> couleur du solide, construite en phase A (seul
    // endroit ou le ColorTool est accessible), consommee en phase B par
    // extractInto. shared_ptr : une seule carte par leaf, partagee sans copie
    // par tous ses sous-solides. Nulle quand le solide est monochrome.
    std::shared_ptr<FaceColorMap> faceColors;
    TDF_Label resolvedLabel; // [13/08] label du prototype (rawShape) — necessaire pour
                              // FindSubShape en aval, resolution couleur par label plutot
                              // que par hash de forme au niveau sous-solide.
    // [31/08] Comment la couleur de CE leaf a ete obtenue (sortie de
    // decideBodyColor). Sans ce champ, le log [COLOR] n'imprimait que le chemin
    // du niveau SOUS-SOLIDE (partColPath) : quand le leaf gagne — c'est-a-dire
    // presque toujours — la ligne disait "tierA-leaf" sans jamais dire comment
    // ce leaf avait ete resolu. Consequence vecue le 31/08 : le correctif
    // "face-uniform-override" tournait et faisait son travail, mais restait
    // totalement invisible dans medusa.log, au point de faire croire qu'il ne
    // se declenchait pas. Un chemin de decision qu'on ne peut pas observer est
    // un chemin qu'on ne peut pas debugger.
    const char* colPath = "none";
    // [18/09] Opacite resolue pour ce corps, 1 = opaque. Voisine de `color`
    // plutot que dedans : Quantity_Color n'a pas de canal alpha, et remplacer
    // le type partout (decideBodyColor, PartJob, extractInto, --selftest-colors)
    // pour un seul flottant aurait touche tout le chemin couleur.
    float alpha = 1.0f;
};

// [31/08] Resultat du balayage des couleurs de face d'un PROTOTYPE, memorise
// pour ses instances. Voir le bloc commente dans collectLeaves pour le pourquoi
// et pour la garantie de mono-thread qui dispense de verrou.
struct FaceScan {
    std::shared_ptr<FaceColorMap> map;    // nulle si aucune face stylee
    std::optional<Quantity_Color> first;  // 1re couleur de face rencontree
    float  firstAlpha = 1.0f;             // [18/09] son opacite
    bool   uniform = true;                // toutes les faces stylees identiques
    size_t nFaces  = 0;                   // faces topologiques du prototype
    size_t nStyled = 0;                   // dont celles portant un style propre
};
static std::unordered_map<const void*, FaceScan> gFaceScanCache;

// [31/08] La decision couleur d'un corps, isolee en fonction PURE : elle ne lit
// que son balayage de faces et la couleur de solide deja resolue, ne touche a
// aucun etat global, et ne depend d'aucun objet OCCT lourd. C'est ce qui la rend
// verifiable sans document XCAF ni fichier STEP — cf. runColorSelfTestCli(),
// "--selftest-colors", qui l'exerce sur les cas limites reels du Scania.
//
// Regle implementee, celle d'OCCT (XCAFPrs::CollectStyleSettings) : le style
// d'une sous-forme ecrase celui de son parent ; la couleur du solide ne vaut que
// pour les faces qui n'ont pas la leur.
struct ColorDecision {
    std::optional<Quantity_Color> col;
    bool        useFaceMap = false;  // transmettre la carte face -> couleur
    const char* path       = "none"; // trace colPath, pour le log [COLOR]
};

static ColorDecision decideBodyColor(const FaceScan& scan,
                                     const std::optional<Quantity_Color>& labelColor,
                                     const char* labelPath) {
    ColorDecision d{ labelColor, false, labelPath };
    // Aucune couleur de face : la couleur du solide gouverne.
    if (scan.nStyled == 0) return d;
    // Toutes les faces s'accordent sur UNE couleur : elle ecrase celle du solide.
    // Un seul materiau suffit, aucun groupe a produire — donc pas de carte.
    if (scan.uniform && scan.nStyled == scan.nFaces) {
        d.path = labelColor ? "face-uniform-override" : "face-uniform";
        d.col  = scan.first;
        return d;
    }
    // Melange : plusieurs couleurs, ou faces stylees et nues cote a cote.
    // extractInto produira les groupes, les faces nues heritant du solide.
    d.useFaceMap = true;
    if (!labelColor) { d.col = scan.first; d.path = "face-first"; }
    return d;
}

static void collectLeaves(const Handle(XCAFDoc_ShapeTool)& shapeTool,
                           const Handle(XCAFDoc_ColorTool)& colorTool,
                           const TDF_Label& label,
                           const TopLoc_Location& parentLoc,
                           std::vector<LeafShape>& out,
                           int depth) {
    if (depth > 64) return; // garde-fou anti-cycle (arbre malformé)

    TDF_Label resolvedLabel = label;
    TopLoc_Location myLoc; // identité par défaut (label non-référence : pas de placement propre)
    if (shapeTool->IsReference(label)) {
        TDF_Label referred;
        if (XCAFDoc_ShapeTool::GetReferredShape(label, referred)) resolvedLabel = referred;
        myLoc = XCAFDoc_ShapeTool::GetLocation(label);
    }
    TopLoc_Location accumLoc = parentLoc * myLoc;

    if (shapeTool->IsAssembly(resolvedLabel)) {
        TDF_LabelSequence components;
        shapeTool->GetComponents(resolvedLabel, components);
        for (Standard_Integer i = 1; i <= components.Length(); i++) {
            collectLeaves(shapeTool, colorTool, components.Value(i), accumLoc, out, depth + 1);
        }
        return;
    }

    // Feuille : shape "prototype" (repère local), on applique le transform composé
    // accumulé depuis la racine pour obtenir sa position réelle dans l'assemblage.
    TopoDS_Shape rawShape = XCAFDoc_ShapeTool::GetShape(resolvedLabel);
    if (rawShape.IsNull()) return;
    TopoDS_Shape placed = rawShape.Moved(accumLoc);

    // Nom : celui de l'INSTANCE (label) est souvent plus parlant que celui du
    // prototype partagé (ex: une vis M3x6 répétée 17 fois garde le même nom
    // prototype "M3x6 FHCS" — c'est déjà le comportement attendu ici, cf. NASSCAD
    // WASM qui affiche aussi les noms de prototype répétés).
    std::string name = "Body";
    Handle(TDataStd_Name) nameAttr;
    if (resolvedLabel.FindAttribute(TDataStd_Name::GetID(), nameAttr)) {
        std::string n = extendedStringToUtf8(nameAttr->Get());
        if (!n.empty()) name = n;
    }

    // Couleur : essayer d'abord au niveau de l'INSTANCE (override possible par
    // usage dans l'assemblage), puis au niveau du PROTOTYPE si rien à l'instance.
    // [13/08] ColorCurv ajoute au chainage — absent avant, alors que la doc
    // officielle OCCT (XCAFDoc_ColorTool) liste explicitement 3 types
    // (Gen/Surf/Curv), pas 2. Reste sur le lookup par LABEL (pas
    // CollectStyleSettings/shape+location) — c'est deja le choix qui evite le
    // bug de correspondance documente ci-dessus, ne pas y toucher.
    std::optional<Quantity_Color> col;
    Quantity_Color qc;
    const char* colPath = "none";
    std::shared_ptr<FaceColorMap> faceMap;
    if (colorTool->GetColor(label, XCAFDoc_ColorSurf, qc)) { col = qc; colPath = "label-inst-Surf"; }
    else if (colorTool->GetColor(label, XCAFDoc_ColorGen, qc)) { col = qc; colPath = "label-inst-Gen"; }
    else if (colorTool->GetColor(label, XCAFDoc_ColorCurv, qc)) { col = qc; colPath = "label-inst-Curv"; }
    else if (colorTool->GetColor(resolvedLabel, XCAFDoc_ColorSurf, qc)) { col = qc; colPath = "label-proto-Surf"; }
    else if (colorTool->GetColor(resolvedLabel, XCAFDoc_ColorGen, qc)) { col = qc; colPath = "label-proto-Gen"; }
    else if (colorTool->GetColor(resolvedLabel, XCAFDoc_ColorCurv, qc)) { col = qc; colPath = "label-proto-Curv"; }

    // [18/09] Opacite du meme niveau. La cascade ci-dessus est laissee INTACTE et
    // celle-ci la reproduit dans le meme ordre, avec la surcharge
    // Quantity_ColorRGBA : quel que soit le maillon qui a gagne, c'est son alpha
    // qu'on lit. Un fichier sans transparence rend 1 partout et rien ne change.
    float labelAlpha = 1.0f;
    {
        Quantity_ColorRGBA rgba;
        if (colorTool->GetColor(label,         XCAFDoc_ColorSurf, rgba)
         || colorTool->GetColor(label,         XCAFDoc_ColorGen,  rgba)
         || colorTool->GetColor(label,         XCAFDoc_ColorCurv, rgba)
         || colorTool->GetColor(resolvedLabel, XCAFDoc_ColorSurf, rgba)
         || colorTool->GetColor(resolvedLabel, XCAFDoc_ColorGen,  rgba)
         || colorTool->GetColor(resolvedLabel, XCAFDoc_ColorCurv, rgba))
            labelAlpha = rgba.Alpha();
    }

    // [13/08] Repli niveau FACE — certains fichiers STEP (pieces multicolores,
    // couleurs par face plutot que par solide) ne posent JAMAIS de couleur au
    // niveau du solide/label. Premiere face coloree trouvee = couleur du solide.
    // [27/08] Balayage COMPLET des faces au lieu de s'arreter a la premiere :
    // les suivantes alimentent la carte face -> couleur que extractInto
    // transformera en groupes.
    //
    // ══ [31/08] CE BLOC N'EST PLUS DANS UN `else`. ═══════════════════════════
    //
    // Il l'etait, et le commentaire du 27/08 justifiait ainsi son cout : "cette
    // branche n'est atteinte QUE par les solides dont aucun label ne porte de
    // couleur, c'est-a-dire exactement les multicolores. Les solides monochromes
    // n'y passent jamais."
    //
    // Cette hypothese — un solide qui porte une couleur de label n'a pas de
    // couleurs de face — est FAUSSE. Autodesk Inventor, via ST-Developer,
    // exporte les deux a la fois : une couleur sur le MANIFOLD_SOLID_BREP *et*
    // des couleurs sur les ADVANCED_FACE. Mesure sur le Part21 brut de
    // Scania-Engine-V8-XT-Turbo.step (374 Mo) :
    //   - 15 176 STYLED_ITEM, dont 14 921 visent une FACE et 254 un solide ;
    //   - les 254 corps ont TOUS une couleur de label, donc les 6 lookups
    //     ci-dessus reussissaient toujours et ce balayage n'etait JAMAIS
    //     execute : aucun corps du fichier n'a jamais recu de tableau `faces` ;
    //   - 98 corps sur 254 ont une couleur de solide qui differe de la couleur
    //     dominante de leurs faces — ils s'affichaient donc faux ;
    //   - 41 d'entre eux ont un solide jaune #DDDD0D sans qu'AUCUNE de leurs
    //     faces ne soit jaune : c'est le jaune vif observe a l'ecran, absent de
    //     FreeCAD qui lit correctement les couleurs de face.
    //
    // La regle appliquee ci-dessous est celle d'OCCT, pas une convention maison :
    // dans XCAFPrs::CollectStyleSettings, le style d'une sous-forme est ecrit
    // dans la map des styles et ECRASE celui de son parent. La couleur du solide
    // ne vaut que pour les faces qui n'ont pas la leur.
    //
    // Cout : le parcours tourne maintenant pour TOUS les solides et plus
    // seulement pour ceux sans couleur de label. C'est un TopExp_Explorer et un
    // lookup de label par face — negligeable devant la tessellation, qui
    // parcourt deja exactement les memes faces juste apres (extractInto).
    // ════════════════════════════════════════════════════════════════════════
    //
    // [31/08 — perf] Le balayage est MEMORISE PAR PROTOTYPE. rawShape sort de
    // GetShape(resolvedLabel) : c'est la forme du prototype, dans son repere
    // local, partagee telle quelle par toutes ses instances (le placement est
    // applique apres, sur `placed`). Deux instances d'une meme piece voient donc
    // exactement les memes TopoDS_Face, les memes TShape, et produisent le meme
    // resultat de balayage — le recalculer par instance etait du travail pur.
    // Sur le Scania : 1295 instances pour 254 prototypes, soit 5x moins d'appels.
    //
    // Ce qui N'EST PAS mis en cache : la couleur du SOLIDE. Elle se resout au
    // niveau de l'INSTANCE (ligne ~998, `label` avant `resolvedLabel`) parce
    // qu'un assemblage peut surcharger la couleur d'une occurrence precise.
    // Seul le balayage des faces, qui ne depend que du prototype, est memorise.
    //
    // Thread-safety : collectLeaves s'execute en PHASE A, mono-thread par
    // construction — c'est la meme garantie qui autorise deja gColorTool et
    // gShapeTool a etre lus sans verrou ici (cf. le commentaire de la boucle
    // phase A, ligne ~1288). Le cache est vide a chaque import (gFaceScanCache
    // .clear(), a cote de gRepairedCount).
    const void* protoKey = rawShape.TShape().get();
    auto itScan = gFaceScanCache.find(protoKey);
    if (itScan == gFaceScanCache.end()) {
        FaceScan sc;
        sc.map = std::make_shared<FaceColorMap>();
        Quantity_Color fqc;
        for (TopExp_Explorer fe(rawShape, TopAbs_FACE); fe.More(); fe.Next()) {
            sc.nFaces++;
            bool got = false;
            // fqc et non qc : qc porte deja la couleur du solide resolue plus
            // haut, l'ecraser ici la perdrait pour les faces non stylees.
            // [18/09] Surcharge Quantity_ColorRGBA : meme resolution, alpha en plus.
            Quantity_ColorRGBA frgba;
            if (colorTool->GetColor(fe.Current(), XCAFDoc_ColorSurf, frgba)) got = true;
            else if (colorTool->GetColor(fe.Current(), XCAFDoc_ColorGen, frgba)) got = true;
            else if (colorTool->GetColor(fe.Current(), XCAFDoc_ColorCurv, frgba)) got = true;
            if (!got) continue;
            fqc = frgba.GetRGB();
            sc.nStyled++;
            if (!sc.first) { sc.first = fqc; sc.firstAlpha = frgba.Alpha(); }
            else if (sc.uniform && !sc.first->IsEqual(fqc)) sc.uniform = false;
            double fr, fg, fb;
            occtColorToSRGB(fqc, fr, fg, fb);
            (*sc.map)[fe.Current().TShape().get()] = FaceRGB{ (float)fr, (float)fg, (float)fb, frgba.Alpha() };
        }
        if (sc.nStyled == 0) sc.map.reset();
        itScan = gFaceScanCache.emplace(protoKey, std::move(sc)).first;
    }
    const FaceScan& scan = itScan->second;

    // La decision elle-meme vit dans decideBodyColor() — fonction pure, testee
    // par "--selftest-colors". La carte est partagee entre instances d'un meme
    // prototype : elle n'est jamais ecrite en aval, donc le partage est sur.
    const ColorDecision dec = decideBodyColor(scan, col, colPath);
    col     = dec.col;
    colPath = dec.path;
    faceMap = dec.useFaceMap ? scan.map : nullptr;
    // Note : le `if (faceMap->size() < 2) faceMap.reset()` d'avant a saute. Il
    // jetait la carte quand une SEULE face etait stylee — or ce cas porte
    // desormais de l'information : une face coloree parmi 500 grises doit donner
    // deux groupes, pas un corps uniforme.

    // [18/09] Quand decideBodyColor a pris la teinte des FACES (regle OCCT :
    // le style d'une sous-forme ecrase celui du parent), c'est l'opacite de ces
    // faces qui vaut, pas celle du label. Comparaison sur la couleur retenue —
    // decideBodyColor reste une fonction pure, sa signature n'a pas bouge et
    // "--selftest-colors" continue de l'exercer telle quelle.
    const float leafAlpha = (dec.col && scan.first && dec.col->IsEqual(*scan.first))
                          ? scan.firstAlpha : labelAlpha;

    out.push_back({name, col, gRootDeflection, placed, rawShape, faceMap, resolvedLabel, colPath, leafAlpha});
}

// ─────────────────────────────────────────────────────────────────────────
// Pipeline STEP : ReadStream en mémoire -> XCAF (noms/couleurs) -> tessellation
// Fallback sur STEPControl_Reader simple (un seul mesh, sans nom/couleur) si
// le fichier n'a pas de structure XCAF exploitable (STEP minimal/AP203 basique).
// ─────────────────────────────────────────────────────────────────────────
// Extrait une valeur du header Part21 (FILE_NAME / FILE_DESCRIPTION) par simple scan
// texte de la zone HEADER (avant DATA;) — meme approche que le panneau proprietes
// d'Autodesk Viewer / FreeCAD : ces champs sont informatifs, pas geometriques.
static std::string headerField(const std::string& head, const std::string& entity, int argIndex){
    size_t p = head.find(entity + "(");
    if(p == std::string::npos) return "";
    size_t end = head.find(";", p);
    if(end == std::string::npos) return "";
    std::string args = head.substr(p, end - p);
    // recupere la argIndex-ieme chaine quotee '...'
    int idx = -1; size_t i = 0;
    while(i < args.size()){
        if(args[i] == '\''){
            size_t close = args.find('\'', i + 1);
            if(close == std::string::npos) break;
            idx++;
            if(idx == argIndex) return args.substr(i + 1, close - i - 1);
            i = close + 1;
        } else i++;
    }
    return "";
}

#include <functional>
#include <TopoDS_Solid.hxx>
#include <ShapeFix_Shell.hxx>
#include <BRepLib.hxx>
#include <BRepFilletAPI_MakeFillet2d.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <gp_GTrsf.hxx>
#include <gp_Pnt2d.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <Geom_Plane.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_SurfaceOfLinearExtrusion.hxx>
#include <Geom_SurfaceOfRevolution.hxx>
#include <Geom_Line.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_TrimmedCurve.hxx>              // [24/09] cf. stepx::exactGeometrySafe
#include <Geom_OffsetCurve.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_SweptSurface.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <ShapeFix_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <Poly_Triangle.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>

// ─────────────────────────────────────────────────────────────────────────
// [15/08] Parallélisation de la tessellation STEP.
// ─────────────────────────────────────────────────────────────────────────
// Constat : BRepMesh_IncrementalMesh est déjà appelé avec son flag de
// parallélisme interne actif (5e argument Standard_True, cf. tessellateShape)
// — mais ce parallélisme n'exploite que les faces D'UNE SEULE shape. Sur un
// assemblage à centaines/milliers de petits corps (vis, plaques, PCB...),
// chaque pièce individuelle a trop peu de faces pour saturer les cœurs, et
// l'ancienne boucle traitait les pièces UNE PAR UNE (séquentiel) : la
// majorité des cœurs restait inactive pendant tout l'import — exactement le
// cas documenté comme goulot (Scania 1449 corps, Voron 195k lignes). Ici :
// même pattern "pull" déjà utilisé pour /smooth et /repair (compteur
// atomique partagé, un thread par cœur), appliqué à la tessellation STEP
// elle-même, sur des JOBS déjà résolus (couleur/nom/déflection) — voir
// processStepBuffer plus bas pour le découpage en deux phases (phase A
// séquentielle = tout ce qui touche le document XCAF partagé ; phase B
// parallèle = repair + tessellation + extraction, qui ne touche plus jamais
// le document XCAF).
template <class F>
static void parallelForIndices(size_t count, unsigned maxThreads, F&& fn) {
    if (count == 0) return;
    unsigned nThreads = std::thread::hardware_concurrency();
    if (nThreads == 0) nThreads = 4; // hardware_concurrency() peut renvoyer 0, filet de secu (meme choix que /smooth et /repair)
    nThreads = (unsigned)std::min((size_t)nThreads, count);
    if (maxThreads > 0) nThreads = std::min(nThreads, maxThreads);
    if (nThreads <= 1) {
        for (size_t i = 0; i < count; i++) fn(i);
        return;
    }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    pool.reserve(nThreads);
    std::exception_ptr firstErr = nullptr;
    std::mutex errMx;
    for (unsigned t = 0; t < nThreads; t++) {
        pool.emplace_back([&]() {
            for (;;) {
                size_t i = next.fetch_add(1);
                if (i >= count) break;
                try {
                    fn(i);
                } catch (...) {
                    std::lock_guard<std::mutex> lk(errMx);
                    if (!firstErr) firstErr = std::current_exception();
                }
            }
        });
    }
    for (auto& th : pool) th.join();
    if (firstErr) std::rethrow_exception(firstErr); // apres le join COMPLET de tous les threads — jamais d'arret en plein calcul des autres
}

// [15/08] Verrou par identité de TShape — nécessaire dès que la tessellation
// passe en parallèle : BRepMesh_IncrementalMesh écrit sa triangulation dans
// le cache interne du TShape (Poly_Triangulation), cache PARTAGÉ entre toutes
// les instances d'un même prototype (cf. commentaire plus haut sur le
// partage de TShape entre instances répétées — "17 vis M3x6 identiques").
// Deux threads tessellant simultanément deux INSTANCES du MÊME prototype
// écriraient concurremment dans ce même cache → course. Un mutex PAR TShape
// (alloué paresseusement, clé = pointeur brut du TShape) isole uniquement les
// pièces qui partagent réellement leur géométrie, sans jamais sérialiser des
// pièces indépendantes entre elles.
struct ShapeLockTable {
    std::mutex mapMx;
    std::unordered_map<const void*, std::unique_ptr<std::mutex>> locks;
    std::mutex& forShape(const TopoDS_Shape& s) {
        const void* key = s.TShape().get();
        std::lock_guard<std::mutex> lk(mapMx);
        auto it = locks.find(key);
        if (it == locks.end()) it = locks.emplace(key, std::make_unique<std::mutex>()).first;
        return *it->second;
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// [19/09] LECTEUR IFC NATIF — ISO 16739, sans IfcOpenShell.
//
// POURQUOI PAS IfcOpenShell, alors que c est la bibliotheque de reference :
//   - LGPL-3.0-or-later. Son article 4 exige, en lien statique, de fournir de
//     quoi RELIER — incompatible avec un binaire unique livre tel quel.
//   - Leur FindOpenCASCADE.cmake ne connait rien au-dela d OCCT 7.9 (que des
//     contournements pour les versions ANTERIEURES) ; MEDUSA tourne sur 8.0.1,
//     sortie en mai 2026 et cassant l ABI.
//   - Des centaines de milliers de lignes generees pour Ifc2x3/Ifc4/Ifc4x3, dans
//     un exe deja a 59 Mo.
// Et surtout : MEDUSA a DEJA tout ce qu il faut. OCCT pour la geometrie, Manifold
// pour les booleens, tessellateShape et extractInto pour l aval. Le lecteur n a
// qu a produire des TopoDS_Shape avec un nom et une couleur.
//
// IFC N EST PAS UN AUTRE FORMAT. C est le MEME conteneur Part-21 que STEP, avec
// un autre schema dedans. Un seul decoupeur sert aux deux.
//
// COUVERTURE MESUREE, banc C++ reel lie a OCCT 8.0.1, six fichiers de six
// origines differentes :
//   AC20-Institute-Var-2  ArchiCAD 20, IFC4 ....  784/784  287 percements
//   AC20-FZK-Haus         KIT, IFC4 ............   90/90    86 couleurs
//   KIT-Simple-Road       IFC4x3 ...............   66/66    66 couleurs
//   aisc_sculpture_param  SteelVis, IFC2x3 .....  351/351  parametrique
//   aisc_sculpture_brep   SteelVis, IFC2x3 .....  351/351  brep explicite
//   Tabel_Chairs          IFC4X1 ...............   31/31   brep avance
// Soit 1673 / 1673. Les deux sculptures AISC sont le MEME modele exporte deux
// fois, une fois en profiles parametriques, une fois en faces explicites : elles
// rendent la meme emprise a 2,4 x 2,5 x 3,1 m. Deux chemins de code sans rien de
// commun qui tombent sur le meme resultat, c est le seul controle qui vaille.
//
// CINQ PIEGES PAYES, dans l ordre ou ils se sont presentes :
//   1. Un IfcMappedItem ne porte AUCUN style : la couleur est sur les items de la
//      representation SOURCE, derriere la carte. Sans traverser la carte, les 253
//      meubles et les 206 fenetres perdent leur couleur — 221 produits colories
//      au lieu de 769.
//   2. Les IfcAnnotation n ont pas de representation 'Body'. Les compter comme
//      des echecs de lecture faisait afficher 87 % la ou la geometrie etait a
//      100 %. Le bon critere n est pas « la forme est-elle nulle » mais « le
//      produit avait-il quelque chose a donner ».
//   3. Le facteur d un IfcConversionBasedUnit est relatif a l unite CITEE, qui
//      peut porter un prefixe : le pouce des fichiers AISC vaut 25,4 MILLIMETRES.
//      Supposer le metre donnait x25400 — une sculpture de 2,9 km de haut.
//   4. Le sens d IfcHalfSpaceSolid.AgreementFlag etait inverse. Voir halfSpace().
//   5. Un IfcClosedShell peut contenir plusieurs coques. Voir sew().
// Aucun de ces cinq n etait visible sur un seul fichier. C est le corpus qui les
// a sortis, pas la relecture du code.
// ═════════════════════════════════════════════════════════════════════════════

namespace nasifc {

using SV = std::string_view;

struct Ent {
    SV type;
    std::vector<SV> args;      // vues sur le tampon d origine : aucune copie
};
using Model = std::unordered_map<uint32_t, Ent>;

// ── decoupage Part-21 ────────────────────────────────────────────────────────
// Ce qu une expression reguliere ne sait pas faire : une chaine ' ... ' contient
// des parentheses, des virgules et des apostrophes doublees ; les arguments sont
// imbriques a profondeur quelconque ; une entite s etale sur des dizaines de
// lignes.
static std::vector<SV> splitArgs(SV s) {
    std::vector<SV> out;
    int depth = 0; bool instr = false; size_t start = 0;
    for (size_t i = 0; i < s.size(); i++) {
        char c = s[i];
        if (instr) {
            if (c == '\'') { if (i + 1 < s.size() && s[i+1] == '\'') { i++; continue; } instr = false; }
        } else if (c == '\'') instr = true;
        else if (c == '(') depth++;
        else if (c == ')') depth--;
        else if (c == ',' && depth == 0) { out.push_back(s.substr(start, i - start)); start = i + 1; }
    }
    out.push_back(s.substr(start));
    for (SV& a : out) {
        while (!a.empty() && (a.front() == ' ' || a.front() == '\n' || a.front() == '\r' || a.front() == '\t')) a.remove_prefix(1);
        while (!a.empty() && (a.back()  == ' ' || a.back()  == '\n' || a.back()  == '\r' || a.back()  == '\t')) a.remove_suffix(1);
    }
    return out;
}

static Model parse(const std::string& body) {
    Model M;
    M.reserve(200000);
    const size_t n = body.size();
    size_t i = body.find("DATA;");
    if (i == std::string::npos) i = 0;
    while (i < n) {
        size_t h = body.find('#', i);
        if (h == std::string::npos) break;
        size_t p = h + 1;
        uint32_t id = 0; bool any = false;
        while (p < n && body[p] >= '0' && body[p] <= '9') { id = id * 10 + (uint32_t)(body[p] - '0'); p++; any = true; }
        if (!any) { i = h + 1; continue; }
        while (p < n && (body[p] == ' ' || body[p] == '\t')) p++;
        if (p >= n || body[p] != '=') { i = h + 1; continue; }
        p++;
        while (p < n && (body[p] == ' ' || body[p] == '\t' || body[p] == '\n' || body[p] == '\r')) p++;
        size_t ts = p;
        while (p < n && (isalnum((unsigned char)body[p]) || body[p] == '_')) p++;
        if (p >= n || p == ts || body[p] != '(') { i = h + 1; continue; }
        SV type(body.data() + ts, p - ts);
        p++;                                   // apres la '(' ouvrante
        size_t as = p;
        int depth = 1; bool instr = false;
        while (p < n && depth) {
            char c = body[p];
            if (instr) {
                if (c == '\'') { if (p + 1 < n && body[p+1] == '\'') { p += 2; continue; } instr = false; }
            } else if (c == '\'') instr = true;
            else if (c == '(') depth++;
            else if (c == ')') depth--;
            p++;
        }
        Ent e; e.type = type;
        e.args = splitArgs(SV(body.data() + as, (p ? p - 1 : as) - as));
        M.emplace(id, std::move(e));
        i = p;
    }
    return M;
}

// ── accesseurs ───────────────────────────────────────────────────────────────
static inline uint32_t refOf(SV a) {
    if (a.size() < 2 || a[0] != '#') return 0;
    uint32_t v = 0;
    for (size_t i = 1; i < a.size(); i++) {
        if (a[i] < '0' || a[i] > '9') return 0;
        v = v * 10 + (uint32_t)(a[i] - '0');
    }
    return v;
}

static void refsInto(SV a, std::vector<uint32_t>& out) {
    for (size_t i = 0; i < a.size(); i++) {
        if (a[i] != '#') continue;
        uint32_t v = 0; size_t j = i + 1; bool any = false;
        while (j < a.size() && a[j] >= '0' && a[j] <= '9') { v = v * 10 + (uint32_t)(a[j] - '0'); j++; any = true; }
        if (any) out.push_back(v);
        i = j - 1;
    }
}
static std::vector<uint32_t> refsOf(SV a) { std::vector<uint32_t> v; refsInto(a, v); return v; }

static double numOf(SV a, double dflt = 0.0) {
    if (a.empty() || a[0] == '$' || a[0] == '*') return dflt;
    try { return std::stod(std::string(a)); } catch (...) { return dflt; }
}

static void numsInto(SV a, std::vector<double>& out) {
    size_t i = 0;
    while (i < a.size()) {
        if ((a[i] >= '0' && a[i] <= '9') || ((a[i] == '-' || a[i] == '+' || a[i] == '.') &&
             i + 1 < a.size() && ((a[i+1] >= '0' && a[i+1] <= '9') || a[i+1] == '.'))) {
            size_t j = i;
            if (a[j] == '-' || a[j] == '+') j++;
            while (j < a.size() && ((a[j] >= '0' && a[j] <= '9') || a[j] == '.')) j++;
            if (j < a.size() && (a[j] == 'E' || a[j] == 'e')) {
                size_t k = j + 1;
                if (k < a.size() && (a[k] == '-' || a[k] == '+')) k++;
                if (k < a.size() && a[k] >= '0' && a[k] <= '9') { j = k; while (j < a.size() && a[j] >= '0' && a[j] <= '9') j++; }
            }
            try { out.push_back(std::stod(std::string(a.substr(i, j - i)))); } catch (...) {}
            i = j;
        } else i++;
    }
}
static std::vector<double> numsOf(SV a) { std::vector<double> v; numsInto(a, v); return v; }

// Chaine Part-21 -> texte. Meme desechappement que l export STEP, a l envers.
static std::string txtOf(SV a) {
    if (a.size() < 2 || a.front() != '\'') return std::string();
    std::string s;
    for (size_t i = 1; i + 1 < a.size(); i++) {
        if (a[i] == '\'' && i + 2 < a.size() && a[i+1] == '\'') { s += '\''; i++; continue; }
        if (a[i] == '\\' && i + 3 < a.size() && a[i+1] == 'X' && a[i+2] == '2' && a[i+3] == '\\') {
            size_t j = i + 4; std::string hex;
            while (j + 3 < a.size() && !(a[j] == '\\' && a[j+1] == 'X' && a[j+2] == '0')) { hex += a[j]; j++; }
            for (size_t k = 0; k + 3 < hex.size(); k += 4) {
                unsigned cp = (unsigned)strtoul(hex.substr(k, 4).c_str(), nullptr, 16);
                if (cp < 0x80) s += (char)cp;
                else if (cp < 0x800) { s += (char)(0xC0 | (cp >> 6)); s += (char)(0x80 | (cp & 0x3F)); }
                else { s += (char)(0xE0 | (cp >> 12)); s += (char)(0x80 | ((cp >> 6) & 0x3F)); s += (char)(0x80 | (cp & 0x3F)); }
            }
            i = j + 3; continue;
        }
        s += a[i];
    }
    return s;
}

static inline bool isEnum(SV a, const char* v) {
    return a.size() >= 3 && a.front() == '.' && a.compare(1, strlen(v), v) == 0;
}

// Listes imbriquees d entiers : ((1,2,3),(4,5,6),...) -> groupes.
// Sert aux CoordIndex des jeux de faces IFC4, ou l indexation est a partir de 1.
static void intGroups(SV a, std::vector<std::vector<uint32_t>>& out) {
    int depth = 0;
    std::vector<uint32_t> cur;
    bool inNum = false; uint64_t v = 0;
    for (size_t i = 0; i < a.size(); i++) {
        char c = a[i];
        if (c >= '0' && c <= '9') { v = v * 10 + (uint64_t)(c - '0'); inNum = true; continue; }
        if (inNum) { cur.push_back((uint32_t)v); v = 0; inNum = false; }
        if (c == '(') { if (++depth == 2) cur.clear(); }
        else if (c == ')') {
            if (depth == 2 && !cur.empty()) { out.push_back(cur); cur.clear(); }
            depth--;
        }
    }
    if (inNum) cur.push_back((uint32_t)v);
    if (!cur.empty() && out.empty()) out.push_back(cur);   // liste plate
}

// Groupes imbriques de REFERENCES : ((#1,#2),(#3,#4)) -> lignes.
// Sert aux grilles de points de controle des surfaces NURBS, ou la structure
// porte le sens : la liste exterieure est le parametre u, l interieure le v.
static void refGroups(SV a, std::vector<std::vector<uint32_t>>& out) {
    int depth = 0;
    std::vector<uint32_t> cur;
    bool inRef = false; uint32_t v = 0;
    for (size_t i = 0; i < a.size(); i++) {
        char c = a[i];
        if (c == '#') { inRef = true; v = 0; continue; }
        if (inRef) {
            if (c >= '0' && c <= '9') { v = v * 10 + (uint32_t)(c - '0'); continue; }
            cur.push_back(v); inRef = false;
        }
        if (c == '(') { if (++depth == 2) cur.clear(); }
        else if (c == ')') {
            if (depth == 2) { out.push_back(cur); cur.clear(); }
            depth--;
        }
    }
    if (inRef) cur.push_back(v);
    if (!cur.empty() && out.empty()) out.push_back(cur);
}

// Groupes imbriques de REELS : ((1.,0.7),(1.,0.7)) -> lignes. Les poids d une
// surface rationnelle ont la meme grille que les points de controle.
static void numGroups(SV a, std::vector<std::vector<double>>& out) {
    int depth = 0;
    std::vector<double> cur;
    size_t i = 0;
    while (i < a.size()) {
        char c = a[i];
        if (c == '(') { if (++depth == 2) cur.clear(); i++; continue; }
        if (c == ')') {
            if (depth == 2) { out.push_back(cur); cur.clear(); }
            depth--; i++; continue;
        }
        if ((c >= '0' && c <= '9') || ((c == '-' || c == '+' || c == '.') &&
             i + 1 < a.size() && ((a[i+1] >= '0' && a[i+1] <= '9') || a[i+1] == '.'))) {
            size_t j = i;
            if (a[j] == '-' || a[j] == '+') j++;
            while (j < a.size() && ((a[j] >= '0' && a[j] <= '9') || a[j] == '.')) j++;
            if (j < a.size() && (a[j] == 'E' || a[j] == 'e')) {
                size_t k = j + 1;
                if (k < a.size() && (a[k] == '-' || a[k] == '+')) k++;
                if (k < a.size() && a[k] >= '0' && a[k] <= '9') { j = k; while (j < a.size() && a[j] >= '0' && a[j] <= '9') j++; }
            }
            try { cur.push_back(std::stod(std::string(a.substr(i, j - i)))); } catch (...) {}
            i = j; continue;
        }
        i++;
    }
    if (!cur.empty() && out.empty()) out.push_back(cur);
}

// Listes imbriquees de reels : ((x,y,z),(x,y,z),...) -> points.
static void ptGroups(SV a, std::vector<std::array<double,3>>& out) {
    int depth = 0;
    std::vector<double> cur;
    size_t i = 0;
    while (i < a.size()) {
        char c = a[i];
        if (c == '(') { if (++depth == 2) cur.clear(); i++; continue; }
        if (c == ')') {
            if (depth == 2) {
                while (cur.size() < 3) cur.push_back(0.0);
                out.push_back({cur[0], cur[1], cur[2]});
                cur.clear();
            }
            depth--; i++; continue;
        }
        if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.') {
            size_t j = i;
            if (a[j] == '-' || a[j] == '+') j++;
            while (j < a.size() && ((a[j] >= '0' && a[j] <= '9') || a[j] == '.')) j++;
            if (j < a.size() && (a[j] == 'E' || a[j] == 'e')) {
                size_t k = j + 1;
                if (k < a.size() && (a[k] == '-' || a[k] == '+')) k++;
                if (k < a.size() && a[k] >= '0' && a[k] <= '9') { j = k; while (j < a.size() && a[j] >= '0' && a[j] <= '9') j++; }
            }
            try { cur.push_back(std::stod(std::string(a.substr(i, j - i)))); } catch (...) {}
            i = j; continue;
        }
        i++;
    }
}

// ── unites ───────────────────────────────────────────────────────────────────
// Ce fichier-ci est en METRES, beaucoup d autres en millimetres. Lire l unite,
// ne jamais la supposer : c est un facteur 1000 sur tout le batiment.
//
// Le piege de l IfcConversionBasedUnit : son facteur n est PAS relatif a l unite
// SI de base, il est relatif a l unite CITEE en 2e argument de son
// IfcMeasureWithUnit — laquelle peut porter un prefixe. Les fichiers AISC
// declarent le pouce ainsi :
//     IFCCONVERSIONBASEDUNIT(#1901,.LENGTHUNIT.,'INCH',#6453)
//       #6453 = IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(25.4),#120061)
//         #120061 = IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)
// soit 25,4 MILLIMETRES. Supposer le metre donne x25400 : une sculpture de
// 2,9 km de haut. Et rien n interdit d empiler (un pied = 12 pouces), donc la
// resolution est recursive, pas un cas particulier.
static double siPrefixOf(SV a) {
    static const struct { const char* n; double f; } PFX[] = {
        {"EXA",1e18},{"PETA",1e15},{"TERA",1e12},{"GIGA",1e9},{"MEGA",1e6},{"KILO",1e3},
        {"HECTO",1e2},{"DECA",1e1},{"DECI",1e-1},{"CENTI",1e-2},{"MILLI",1e-3},
        {"MICRO",1e-6},{"NANO",1e-9},{"PICO",1e-12},{"FEMTO",1e-15},{"ATTO",1e-18}};
    // Aucun de ces seize noms n est le prefixe d un autre : la recherche par
    // sous-chaine sur l enumeration pointee (.MILLI.) est sans ambiguite.
    for (const auto& p : PFX) if (a.find(p.n) != SV::npos) return p.f;
    return 1.0;
}

// Facteur d une unite vers son unite SI de base (metre, radian).
static double unitToBase(const Model& M, uint32_t id, int depth = 0) {
    if (depth > 8) return 1.0;                            // garde-fou sur un cycle
    auto it = M.find(id);
    if (it == M.end()) return 1.0;
    const Ent& e = it->second;
    if (e.type == "IFCSIUNIT")
        return e.args.size() >= 3 ? siPrefixOf(e.args[2]) : 1.0;
    if (e.type == "IFCCONVERSIONBASEDUNIT" ||
        e.type == "IFCCONVERSIONBASEDUNITWITHOFFSET") {
        if (e.args.size() < 4) return 1.0;
        auto mw = M.find(refOf(e.args[3]));               // IfcMeasureWithUnit
        if (mw == M.end() || mw->second.args.size() < 2) return 1.0;
        auto v = numsOf(mw->second.args[0]);              // IFCLENGTHMEASURE(25.4)
        if (v.empty() || v[0] == 0.0) return 1.0;
        return v[0] * unitToBase(M, refOf(mw->second.args[1]), depth + 1);
    }
    return 1.0;
}

// Cherche dans un IfcUnitAssignment l unite du type demande et rend son facteur.
static bool unitIn(const Model& M, uint32_t asg, const char* kind, double& out) {
    auto a = M.find(asg);
    if (a == M.end() || a->second.type != "IFCUNITASSIGNMENT" || a->second.args.empty())
        return false;
    for (uint32_t u : refsOf(a->second.args[0])) {
        auto it = M.find(u);
        if (it == M.end() || it->second.args.size() < 2) continue;
        if (it->second.args[1].find(kind) == SV::npos) continue;
        if (it->second.type != "IFCSIUNIT" &&
            it->second.type != "IFCCONVERSIONBASEDUNIT" &&
            it->second.type != "IFCCONVERSIONBASEDUNITWITHOFFSET") continue;
        out = unitToBase(M, u);
        return true;
    }
    return false;
}

// Les unites du MODELE sont celles de l IfcProject (UnitsInContext, 9e argument).
// Un fichier peut contenir d autres IfcUnitAssignment — un echeancier de couts,
// une bibliotheque — et le modele est range dans une table de hachage : prendre
// "le premier trouve" rendrait la lecture non deterministe. On part du projet,
// et on ne balaie qu a defaut.
static double namedUnitToBase(const Model& M, const char* kind, double dflt) {
    double f = dflt;
    for (const auto& kv : M) {
        if (kv.second.type != "IFCPROJECT" && kv.second.type != "IFCPROJECTLIBRARY")
            continue;
        if (kv.second.args.size() >= 9 && unitIn(M, refOf(kv.second.args[8]), kind, f))
            return f;
    }
    for (const auto& kv : M)
        if (kv.second.type == "IFCUNITASSIGNMENT" && unitIn(M, kv.first, kind, f))
            return f;
    return dflt;
}

static double lengthScale(const Model& M) {
    return 1000.0 * namedUnitToBase(M, "LENGTHUNIT", 1.0);  // -> mm
}


// ═══ LE LECTEUR ══════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// [22/09] TRIANGULATION DE POLYGONES — sans noyau CAD
//
// POURQUOI CE CODE EXISTE. Un IfcTriangulatedFaceSet, un IfcPolygonalFaceSet,
// un IfcFacetedBrep : ce sont des MAILLAGES, pas des solides. Les faire passer
// par un B-Rep — une TopoDS_Face par facette, puis BRepBuilderAPI_Sewing, puis
// BRepMesh — c'est demander a un noyau CAD de reconstruire ce que le fichier
// donnait deja, puis de le redecouper.
//
// Ce n'est pas une opinion, c'est mesure, et l'implementation de reference fait
// la meme erreur. IfcOpenShell, issue #862 : « the triangulated face set is
// still using the brep under the hood » — 6 s en tesselle contre 4 s en brep
// facette, pour une geometrie qui est un mapping 1-pour-1. Issue #1421 :
// 2 251 faces qui doivent rendre 4 228 triangles en rendent 4 240, en 6,5 s, et
// le maillage ressort non-manifold. Douze triangles en trop chez eux, 310 chez
// moi sur AC20-FZK-Haus : meme mecanisme, les jonctions en T que la couture
// fabrique.
//
// Et c'est de la que venait le plantage : BRepBuilderAPI_MakeFace::Add sur une
// face nulle. En ne construisant plus de face du tout, la classe entiere de
// defaut disparait — on ne se protege pas d'un segfault, on retire le code qui
// pouvait en produire un.
//
// CE QUE CELA DONNE EN PLUS. Le fichier dit LUI-MEME quels sommets sont
// partages : deux facettes qui citent le meme IfcCartesianPoint, ou le meme
// indice dans un IfcCartesianPointList3D, partagent ce sommet. On garde cette
// identite telle quelle. Pas de soudure par coordonnees, pas de tolerance, pas
// de jonction en T inventee. La topologie rendue est EXACTEMENT celle ecrite.
//
// Reste a triangulise les faces a plus de trois cotes, et celles a trous. C'est
// un probleme de geometrie plane resolu depuis longtemps — decoupe d'oreilles
// (Meisters 1975, van Gogh… non : Meisters, « Polygons have ears », American
// Mathematical Monthly 82) avec pontage des trous. Deux cents lignes, aucune
// dependance, et un repli en eventail si jamais le polygone est degenere.
// ═════════════════════════════════════════════════════════════════════════════
namespace tri {

struct P2 { double x, y; };

static inline double cross2(const P2& a, const P2& b, const P2& c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// Point dans le triangle, bords inclus — un sommet POSE sur une arete interdit
// l'oreille, sinon on fabrique un triangle a aire nulle.
static bool inTri(const P2& a, const P2& b, const P2& c, const P2& p) {
    double d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
    bool neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    bool pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(neg && pos);
}

static double area2(const std::vector<P2>& p) {
    double s = 0;
    for (size_t i = 0, n = p.size(); i < n; i++) {
        const P2& a = p[i]; const P2& b = p[(i + 1) % n];
        s += a.x * b.y - b.x * a.y;
    }
    return s * 0.5;
}

// Decoupe d'oreilles sur un polygone simple. `out` recoit des triplets
// d'indices DANS `poly`. Rend false si le polygone resiste (auto-intersectant,
// degenere) — l'appelant decide alors du repli.
static bool earClip(const std::vector<P2>& poly, std::vector<uint32_t>& out) {
    size_t n = poly.size();
    if (n < 3) return false;
    if (n == 3) { out.push_back(0); out.push_back(1); out.push_back(2); return true; }

    std::vector<uint32_t> v(n);
    for (size_t i = 0; i < n; i++) v[i] = (uint32_t)i;
    // Sens direct impose : la decoupe teste la convexite par le signe.
    if (area2(poly) < 0) std::reverse(v.begin(), v.end());

    size_t guard = 0, limit = n * n + 16;
    while (v.size() > 3 && guard++ < limit) {
        bool clipped = false;
        for (size_t i = 0; i < v.size(); i++) {
            size_t ip = (i + v.size() - 1) % v.size(), in = (i + 1) % v.size();
            const P2& a = poly[v[ip]]; const P2& b = poly[v[i]]; const P2& c = poly[v[in]];
            if (cross2(a, b, c) <= 0) continue;          // sommet reflex : pas une oreille
            bool ok = true;
            for (size_t k = 0; k < v.size() && ok; k++) {
                if (k == ip || k == i || k == in) continue;
                const P2& q = poly[v[k]];
                // LE PIEGE DU PONTAGE. Ponter un trou DUPLIQUE deux sommets :
                // le pont est parcouru dans les deux sens, donc le polygone
                // simple equivalent contient deux fois le meme point. Un test
                // d'appartenance bords inclus declare alors ce doublon "dans"
                // toute oreille qui le touche — plus aucune oreille n'est
                // jamais trouvee, et la facette entiere est perdue.
                // Mesure : 2 009 facettes a trous jetees sur l'export Revit.
                // On ignore donc les sommets CONFONDUS avec ceux de l'oreille.
                if ((std::fabs(q.x-a.x) < 1e-9 && std::fabs(q.y-a.y) < 1e-9) ||
                    (std::fabs(q.x-b.x) < 1e-9 && std::fabs(q.y-b.y) < 1e-9) ||
                    (std::fabs(q.x-c.x) < 1e-9 && std::fabs(q.y-c.y) < 1e-9)) continue;
                if (inTri(a, b, c, q)) ok = false;
            }
            if (!ok) continue;
            out.push_back(v[ip]); out.push_back(v[i]); out.push_back(v[in]);
            v.erase(v.begin() + i);
            clipped = true;
            break;
        }
        if (!clipped) return false;                      // plus aucune oreille : on rend la main
    }
    if (v.size() != 3) return false;
    out.push_back(v[0]); out.push_back(v[1]); out.push_back(v[2]);
    return true;
}

// Segments [a,b] et [c,d] se croisent-ils STRICTEMENT ? Sert au pontage : un
// pont qui traverse une arete du polygone produirait un maillage croise.
static bool segCross(const P2& a, const P2& b, const P2& c, const P2& d) {
    double d1 = cross2(c, d, a), d2 = cross2(c, d, b);
    double d3 = cross2(a, b, c), d4 = cross2(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Ponte chaque trou dans le contour exterieur : on relie le sommet du trou le
// plus proche d'un sommet du contour par un "pont" — deux aretes confondues
// parcourues dans les deux sens — ce qui rend un polygone SIMPLE equivalent,
// que la decoupe d'oreilles sait traiter. Methode classique (Eberly) ; on
// choisit la paire la plus courte qui ne traverse aucune arete existante.
static bool bridgeHoles(std::vector<P2>& pts, std::vector<uint32_t>& outer,
                        std::vector<std::vector<uint32_t>>& holes) {
    for (auto& hole : holes) {
        if (hole.size() < 3) continue;
        // le trou doit tourner a l'envers du contour pour que le pont ferme bien
        if ((area2([&]{ std::vector<P2> q; for (uint32_t k : hole) q.push_back(pts[k]); return q; }()) > 0)
            == (area2([&]{ std::vector<P2> q; for (uint32_t k : outer) q.push_back(pts[k]); return q; }()) > 0))
            std::reverse(hole.begin(), hole.end());

        double best = 1e300; size_t bi = 0, bj = 0; bool found = false;
        for (size_t i = 0; i < outer.size(); i++) {
            for (size_t j = 0; j < hole.size(); j++) {
                const P2& A = pts[outer[i]]; const P2& B = pts[hole[j]];
                double d = (A.x-B.x)*(A.x-B.x) + (A.y-B.y)*(A.y-B.y);
                if (d >= best) continue;
                bool blocked = false;
                auto scan = [&](const std::vector<uint32_t>& loop) {
                    for (size_t k = 0; k < loop.size() && !blocked; k++) {
                        uint32_t p = loop[k], q = loop[(k + 1) % loop.size()];
                        if (p == outer[i] || q == outer[i] || p == hole[j] || q == hole[j]) continue;
                        if (segCross(A, B, pts[p], pts[q])) blocked = true;
                    }
                };
                scan(outer); if (!blocked) scan(hole);
                for (auto& h2 : holes) { if (&h2 != &hole && !blocked) scan(h2); }
                if (blocked) continue;
                best = d; bi = i; bj = j; found = true;
            }
        }
        if (!found) return false;
        // insertion : ...outer[bi], hole[bj..bj], outer[bi]...
        std::vector<uint32_t> merged;
        merged.reserve(outer.size() + hole.size() + 2);
        for (size_t i = 0; i <= bi; i++) merged.push_back(outer[i]);
        for (size_t j = 0; j < hole.size(); j++) merged.push_back(hole[(bj + j) % hole.size()]);
        merged.push_back(hole[bj]);
        for (size_t i = bi; i < outer.size(); i++) merged.push_back(outer[i]);
        outer.swap(merged);
    }
    return true;
}

// Triangule une facette 3D plane : `loop` est le contour, `voids` les trous,
// tous indices dans `xyz` (x,y,z entrelaces). Rend des triplets d'indices dans
// `xyz`. Le plan est trouve par la methode de Newell, qui tolere un contour
// legerement gauche — ce que les exports BIM produisent tout le temps.
static bool faceToTriangles(const std::vector<float>& xyz,
                            const std::vector<uint32_t>& loop,
                            const std::vector<std::vector<uint32_t>>& voids,
                            std::vector<uint32_t>& out) {
    if (loop.size() < 3) return false;
    auto X = [&](uint32_t k){ return (double)xyz[k*3]; };
    auto Y = [&](uint32_t k){ return (double)xyz[k*3+1]; };
    auto Z = [&](uint32_t k){ return (double)xyz[k*3+2]; };

    double nx = 0, ny = 0, nz = 0;                       // Newell
    for (size_t i = 0, n = loop.size(); i < n; i++) {
        uint32_t a = loop[i], b = loop[(i + 1) % n];
        nx += (Y(a) - Y(b)) * (Z(a) + Z(b));
        ny += (Z(a) - Z(b)) * (X(a) + X(b));
        nz += (X(a) - X(b)) * (Y(a) + Y(b));
    }
    double ax = std::fabs(nx), ay = std::fabs(ny), az = std::fabs(nz);
    int drop = (ax >= ay && ax >= az) ? 0 : (ay >= az ? 1 : 2);   // axe dominant retire
    if (ax + ay + az < 1e-20) return false;              // facette d'aire nulle

    // Table locale : indice global -> indice 2D, pour ne projeter qu'une fois.
    std::vector<uint32_t> gid;
    std::vector<P2> pts;
    std::unordered_map<uint32_t, uint32_t> seen;
    auto push = [&](uint32_t g) -> uint32_t {
        auto it = seen.find(g);
        if (it != seen.end()) return it->second;
        double u = (drop == 0) ? Y(g) : X(g);
        double v = (drop == 2) ? Y(g) : Z(g);
        // orientation coherente selon l'axe retire, pour que le signe de l'aire
        // corresponde bien au sens du contour vu depuis la normale
        if (drop == 1) { u = Z(g); v = X(g); }
        uint32_t k = (uint32_t)pts.size();
        pts.push_back({u, v}); gid.push_back(g); seen.emplace(g, k);
        return k;
    };
    std::vector<uint32_t> outer;
    outer.reserve(loop.size());
    for (uint32_t g : loop) outer.push_back(push(g));
    std::vector<std::vector<uint32_t>> holes;
    for (const auto& vd : voids) {
        if (vd.size() < 3) continue;
        std::vector<uint32_t> h;
        for (uint32_t g : vd) h.push_back(push(g));
        holes.push_back(std::move(h));
    }

    if (!holes.empty() && !bridgeHoles(pts, outer, holes)) return false;

    std::vector<uint32_t> tris;
    if (!earClip([&]{ std::vector<P2> q; q.reserve(outer.size());
                      for (uint32_t k : outer) q.push_back(pts[k]); return q; }(), tris))
        return false;

    // Les indices rendus par earClip pointent dans la liste `outer` compactee.
    for (size_t i = 0; i + 2 < tris.size(); i += 3) {
        uint32_t a = gid[outer[tris[i]]], b = gid[outer[tris[i+1]]], c = gid[outer[tris[i+2]]];
        if (a == b || b == c || a == c) continue;        // degenere : on le jette
        out.push_back(a); out.push_back(b); out.push_back(c);
    }
    return true;
}

} // namespace tri

// Entiers d'une liste plate : (1,2,3) -> 1,2,3.
static void intsInto(SV a, std::vector<uint32_t>& out) {
    uint64_t v = 0; bool in = false;
    for (char c : a) {
        if (c >= '0' && c <= '9') { v = v * 10 + (uint64_t)(c - '0'); in = true; continue; }
        if (in) { out.push_back((uint32_t)v); v = 0; in = false; }
    }
    if (in) out.push_back((uint32_t)v);
}

// Arc de cercle PAR TROIS POINTS (IfcArcIndex) : on rend les points
// intermediaires, les extremites etant posees par l'appelant.
// Le nombre de segments vient d'une fleche maximale — sagitta — de 0,5 mm, et
// non d'un pas angulaire fixe : un arc de 50 mm et un arc de 5 m ne meritent
// pas le meme nombre de cotes.
template <class F>
static void arcThrough(double x1, double y1, double x2, double y2,
                       double x3, double y3, F&& emit) {
    double d = 2.0 * (x1*(y2-y3) + x2*(y3-y1) + x3*(y1-y2));
    if (std::fabs(d) < 1e-12) return;                 // trois points alignes : segment droit
    double s1 = x1*x1 + y1*y1, s2 = x2*x2 + y2*y2, s3 = x3*x3 + y3*y3;
    double cx = (s1*(y2-y3) + s2*(y3-y1) + s3*(y1-y2)) / d;
    double cy = (s1*(x3-x2) + s2*(x1-x3) + s3*(x2-x1)) / d;
    double r  = std::hypot(x1-cx, y1-cy);
    if (!(r > 1e-9) || !std::isfinite(r)) return;
    double a1 = std::atan2(y1-cy, x1-cx);
    double a2 = std::atan2(y2-cy, x2-cx);
    double a3 = std::atan2(y3-cy, x3-cx);
    const double TAU = 2.0 * M_PI;
    auto norm = [&](double a){ while (a < 0) a += TAU; while (a >= TAU) a -= TAU; return a; };
    // sens de parcours : celui qui passe par le point du milieu
    double f2 = norm(a2 - a1), f3 = norm(a3 - a1);
    double sweep = (f2 <= f3) ? f3 : -(TAU - f3);     // direct si le milieu est avant l'arrivee
    const double SAG = 0.5;                           // mm
    double step = (r > SAG) ? 2.0 * std::acos(1.0 - SAG / r) : M_PI / 2;
    int n = (int)std::ceil(std::fabs(sweep) / std::max(1e-3, step));
    if (n < 2) n = 2;
    if (n > 256) n = 256;
    for (int k = 1; k < n; k++) {
        double a = a1 + sweep * ((double)k / n);
        emit(cx + r * std::cos(a), cy + r * std::sin(a));
    }
}

struct Style { float r = 0.6f, g = 0.6f, b = 0.6f, a = 1.0f; bool set = false; };

// Les angles d un IfcRevolvedAreaSolid suivent l unite d angle DECLAREE : le
// radian par defaut, mais tres souvent le degre via un IfcConversionBasedUnit.
// Se tromper fait tourner une piece de 57 tours au lieu d un quart.
static double gAngleToRad = 1.0;

// Meme mecanique, meme piege : le degre est declare comme 0,01745... RADIAN,
// et rien n interdit de le declarer en milliradians. La base est le radian.
static double angleScale(const Model& M) {
    return namedUnitToBase(M, "PLANEANGLEUNIT", 1.0);
}

class Reader {
public:
    const Model& M;
    double s;                                   // echelle vers le mm
    std::unordered_map<uint32_t, gp_Trsf> plcCache;
    std::unordered_map<uint32_t, Style> styleOf; // item de representation -> style
    std::map<std::string, int> unsupported;
    int nSewed = 0, nOpen = 0, freeEdges = 0, nMultiShell = 0;  // diagnostic de couture
    int nAdvFace = 0, nAdvFaceFail = 0;        // diagnostic du brep avance
    int nAttached = 0, nAttachSkipWires = 0, nAttachSkipWire = 0, nAttachSkipN = 0, nAttachThrow = 0;

    Reader(const Model& m, double scale) : M(m), s(scale) {}

    const Ent* get(uint32_t i) const {
        auto it = M.find(i);
        return it == M.end() ? nullptr : &it->second;
    }

    // ── primitives ───────────────────────────────────────────────────────────
    gp_Pnt pnt(uint32_t i) const {
        const Ent* e = get(i);
        if (!e || e->args.empty()) return gp_Pnt();
        auto v = numsOf(e->args[0]);
        while (v.size() < 3) v.push_back(0.0);
        return gp_Pnt(v[0]*s, v[1]*s, v[2]*s);
    }
    void pnt2(uint32_t i, double& x, double& y) const {
        x = y = 0.0;
        const Ent* e = get(i);
        if (!e || e->args.empty()) return;
        auto v = numsOf(e->args[0]);
        if (v.size() > 0) x = v[0]*s;
        if (v.size() > 1) y = v[1]*s;
    }
    gp_Dir dirv(uint32_t i, double dx, double dy, double dz) const {
        const Ent* e = get(i);
        if (!e || e->args.empty()) return gp_Dir(dx, dy, dz);
        auto v = numsOf(e->args[0]);
        while (v.size() < 3) v.push_back(0.0);
        if (v[0] == 0 && v[1] == 0 && v[2] == 0) return gp_Dir(dx, dy, dz);
        return gp_Dir(v[0], v[1], v[2]);
    }
    gp_Ax3 axis3(uint32_t i) const {
        const Ent* e = get(i);
        if (!e || e->args.empty()) return gp_Ax3();
        gp_Pnt o = refOf(e->args[0]) ? pnt(refOf(e->args[0])) : gp_Pnt();
        gp_Dir z(0, 0, 1);
        if (e->args.size() > 1 && refOf(e->args[1])) z = dirv(refOf(e->args[1]), 0, 0, 1);
        if (e->args.size() > 2 && refOf(e->args[2])) {
            gp_Dir x = dirv(refOf(e->args[2]), 1, 0, 0);
            try { return gp_Ax3(o, z, x); } catch (...) {}
        }
        return gp_Ax3(o, z);
    }

    // IfcLocalPlacement forme une CHAINE : chaque placement est relatif a son
    // parent jusqu a la racine. Ne pas la remonter met tout le batiment a
    // l origine — le controle qui l a valide : emprise 58 x 38 x 15,3 m et
    // altitudes -3,30 a +12,05 m, conformes aux 5 etages declares.
    gp_Trsf placement(uint32_t i) {
        auto c = plcCache.find(i);
        if (c != plcCache.end()) return c->second;
        gp_Trsf t;
        const Ent* e = get(i);
        if (e) {
            if (e->type == "IFCLOCALPLACEMENT" && !e->args.empty()) {
                uint32_t rel = refOf(e->args[0]);
                uint32_t own = e->args.size() > 1 ? refOf(e->args[1]) : 0;
                gp_Trsf loc;
                const Ent* oe = get(own);
                if (oe && oe->type == "IFCAXIS2PLACEMENT3D") loc.SetTransformation(axis3(own), gp_Ax3());
                t = rel ? (placement(rel) * loc) : loc;
            } else if (e->type == "IFCAXIS2PLACEMENT3D") {
                t.SetTransformation(axis3(i), gp_Ax3());
            }
        }
        plcCache.emplace(i, t);
        return t;
    }

    // ── profils 2D ───────────────────────────────────────────────────────────
    bool wireOfCurve(uint32_t i, TopoDS_Wire& out) {
        const Ent* e = get(i);
        if (!e) return false;
        std::vector<std::pair<double,double>> pts;
        if (e->type == "IFCPOLYLINE") {
            for (uint32_t p : refsOf(e->args[0])) { double x, y; pnt2(p, x, y); pts.emplace_back(x, y); }
        } else if (e->type == "IFCINDEXEDPOLYCURVE" && !e->args.empty()) {
            // [22/09] LA COURBE COMPACTE D'IFC4, et la plus grosse lacune qu'on
            // ait eue : 2 308 occurrences dans un seul export Revit, qui
            // faisaient echouer 1 145 produits sur 1 552 — le fichier se
            // chargeait sans planter en n'affichant qu'un quart du batiment.
            //
            // Au lieu d'une IfcCartesianPoint par sommet, une liste de points
            // partagee et des SEGMENTS qui la referencent par INDICE, a partir
            // de 1 :
            //   IfcLineIndex(( i1, i2, ... ))  polyligne sur ces points
            //   IfcArcIndex (( i1, i2, i3 ))   arc de cercle PAR TROIS POINTS
            // Segments absent ($) : toute la liste est une seule polyligne,
            // c'est le cas de la grande majorite.
            const auto* pl = pointList(refOf(e->args[0]));
            if (!pl || pl->size() < 2) return false;
            auto at = [&](long k, double& x, double& y) {
                if (k < 1 || (size_t)k > pl->size()) return false;
                x = (*pl)[k-1][0]; y = (*pl)[k-1][1]; return true;
            };
            auto push = [&](double x, double y) {
                if (!pts.empty() && std::fabs(pts.back().first - x) < 1e-9
                                 && std::fabs(pts.back().second - y) < 1e-9) return;
                pts.emplace_back(x, y);
            };
            SV segs = e->args.size() > 1 ? e->args[1] : SV();
            if (segs.empty() || segs[0] == '$') {
                for (const auto& p : *pl) push(p[0], p[1]);
            } else {
                // Decoupage des segments : on avance dans la chaine en repérant
                // IFCLINEINDEX / IFCARCINDEX et la liste d'entiers qui suit.
                size_t k = 0;
                while (k < segs.size()) {
                    bool arc = false;
                    size_t hit = SV::npos;
                    size_t a = segs.find("IFCARCINDEX", k), l = segs.find("IFCLINEINDEX", k);
                    if (a != SV::npos && (l == SV::npos || a < l)) { hit = a; arc = true; }
                    else if (l != SV::npos) { hit = l; arc = false; }
                    if (hit == SV::npos) break;
                    size_t o = segs.find('(', hit);
                    if (o == SV::npos) break;
                    int depth = 0; size_t c = o;
                    for (; c < segs.size(); c++) {
                        if (segs[c] == '(') depth++;
                        else if (segs[c] == ')') { depth--; if (!depth) break; }
                    }
                    if (c >= segs.size()) break;
                    std::vector<uint32_t> ix;
                    intsInto(segs.substr(o, c - o + 1), ix);
                    k = c + 1;
                    if (arc && ix.size() >= 3) {
                        double x1,y1,x2,y2,x3,y3;
                        if (!at(ix[0],x1,y1) || !at(ix[1],x2,y2) || !at(ix[2],x3,y3)) continue;
                        push(x1, y1);
                        arcThrough(x1,y1,x2,y2,x3,y3, push);
                        push(x3, y3);
                    } else {
                        for (uint32_t z : ix) { double x,y; if (at(z,x,y)) push(x,y); }
                    }
                }
            }
        } else if (e->type == "IFCCOMPOSITECURVE") {
            for (uint32_t sg : refsOf(e->args[0])) {
                const Ent* se = get(sg);
                if (!se || se->args.size() < 3) continue;
                const Ent* pc = get(refOf(se->args[2]));
                if (pc && pc->type == "IFCPOLYLINE") {
                    std::vector<std::pair<double,double>> sub;
                    for (uint32_t p : refsOf(pc->args[0])) { double x, y; pnt2(p, x, y); sub.emplace_back(x, y); }
                    if (!isEnum(se->args[1], "T")) std::reverse(sub.begin(), sub.end());
                    if (!pts.empty() && !sub.empty() &&
                        std::fabs(pts.back().first - sub[0].first) < 1e-7 &&
                        std::fabs(pts.back().second - sub[0].second) < 1e-7)
                        sub.erase(sub.begin());
                    for (auto& q : sub) pts.push_back(q);
                } else unsupported[std::string("CompositeCurveSegment:") + (pc ? std::string(pc->type) : "?")]++;
            }
        } else { unsupported[std::string("curve:") + std::string(e->type)]++; return false; }
        if (pts.size() > 1 && std::fabs(pts.front().first - pts.back().first) < 1e-9
                           && std::fabs(pts.front().second - pts.back().second) < 1e-9)
            pts.pop_back();
        if (pts.size() < 3) return false;
        BRepBuilderAPI_MakePolygon mp;
        for (auto& q : pts) mp.Add(gp_Pnt(q.first, q.second, 0));
        mp.Close();
        if (!mp.IsDone()) return false;
        out = mp.Wire();
        return true;
    }

    // ── profils normalises de charpente ──────────────────────────────────────
    // I, L, T, U : la norme les donne par leurs COTES, pas par un contour. On
    // construit le contour, puis on arrondit les sommets que la norme designe.
    //
    // Deux regles qui valent pour les quatre :
    //   - l origine est au CENTRE de la boite englobante, jamais a un coin ;
    //   - les rayons de conge sont facultatifs ; absents, le profil est a angles
    //     vifs et c est correct. S ils sont la, les ignorer perd de la section :
    //     un W12x96 fait 27,89 in2 a angles vifs contre 28,2 au catalogue, et
    //     l ecart, ce sont exactement les quatre conges d ame.
    //
    // Les pentes d aile (LegSlope, FlangeSlope, WebSlope) sont lues mais pas
    // construites : aucun des fichiers du corpus n en declare, et je ne livre pas
    // une geometrie que je ne peux pas verifier. Le compteur le dira le jour ou
    // un fichier en portera.
    static double optNum(const std::vector<SV>& a, size_t k, double dflt) {
        if (k >= a.size()) return dflt;
        SV v = a[k];
        if (v.empty() || v[0] == '$' || v[0] == '*') return dflt;
        return numOf(v, dflt);
    }

    // Face depuis une polyligne fermee, avec arrondi des sommets designes.
    // Si l arrondi echoue, on rend la face a angles vifs : une aile sans son
    // conge reste une aile, une face nulle n est rien.
    bool outlineFace(const std::vector<gp_Pnt2d>& pts,
                     const std::vector<std::pair<size_t,double>>& rounds,
                     TopoDS_Face& out) {
        if (pts.size() < 3) return false;
        BRepBuilderAPI_MakePolygon mp;
        for (const gp_Pnt2d& p : pts) mp.Add(gp_Pnt(p.X(), p.Y(), 0));
        mp.Close();
        if (!mp.IsDone()) return false;
        BRepBuilderAPI_MakeFace mf(mp.Wire(), Standard_True);
        if (!mf.IsDone()) return false;
        TopoDS_Face f = mf.Face();

        std::vector<std::pair<size_t,double>> use;
        for (const auto& r : rounds)
            if (r.second > 1e-9 && r.first < pts.size()) use.push_back(r);
        if (use.empty()) { out = f; return true; }

        try {
            BRepFilletAPI_MakeFillet2d fil(f);
            TopTools_IndexedMapOfShape vm;
            TopExp::MapShapes(f, TopAbs_VERTEX, vm);
            int added = 0;
            for (const auto& r : use) {
                const gp_Pnt2d& t = pts[r.first];
                for (int k = 1; k <= vm.Extent(); k++) {
                    gp_Pnt v = BRep_Tool::Pnt(TopoDS::Vertex(vm(k)));
                    if (std::fabs(v.X() - t.X()) < 1e-7 && std::fabs(v.Y() - t.Y()) < 1e-7) {
                        fil.AddFillet(TopoDS::Vertex(vm(k)), r.second);
                        added++;
                        break;
                    }
                }
            }
            if (added) {
                fil.Build();
                if (fil.IsDone()) {
                    TopoDS_Shape sh = fil.Shape();
                    if (!sh.IsNull() && sh.ShapeType() == TopAbs_FACE) {
                        out = TopoDS::Face(sh);
                        return true;
                    }
                }
                unsupported["profile-fillet-failed"]++;
            }
        } catch (...) { unsupported["profile-fillet-failed"]++; }
        out = f;                                  // repli : angles vifs
        return true;
    }

    // Contour d un profil normalise. Rend false si le type n en est pas un.
    bool standardOutline(const Ent& e, std::vector<gp_Pnt2d>& p,
                         std::vector<std::pair<size_t,double>>& r) {
        const std::vector<SV>& a = e.args;
        auto slope = [&](size_t k) {
            if (optNum(a, k, 0.0) != 0.0) unsupported["profile-slope-ignored"]++;
        };
        if (e.type == "IFCISHAPEPROFILEDEF" && a.size() >= 7) {
            // 3=OverallWidth 4=OverallDepth 5=WebThickness 6=FlangeThickness
            // 7=FilletRadius 8=FlangeEdgeRadius 9=FlangeSlope
            double hb = optNum(a,3,0)*s/2, hh = optNum(a,4,0)*s/2;
            double tw = optNum(a,5,0)*s,   tf = optNum(a,6,0)*s;
            double rf = optNum(a,7,0)*s,   re = optNum(a,8,0)*s;
            slope(9);
            if (hb <= 0 || hh <= 0 || tw <= 0 || tf <= 0 || tw >= 2*hb || 2*tf >= 2*hh)
                return false;
            double hw = tw/2, yb = -hh+tf, yt = hh-tf;
            p = {{ hb,-hh},{ hb,yb},{ hw,yb},{ hw,yt},{ hb,yt},{ hb,hh},
                 {-hb, hh},{-hb,yt},{-hw,yt},{-hw,yb},{-hb,yb},{-hb,-hh}};
            r = {{2,rf},{3,rf},{8,rf},{9,rf},{1,re},{4,re},{7,re},{10,re}};
            return true;
        }
        if (e.type == "IFCLSHAPEPROFILEDEF" && a.size() >= 6) {
            // 3=Depth 4=Width 5=Thickness 6=FilletRadius 7=EdgeRadius 8=LegSlope
            double hd = optNum(a,3,0)*s/2;
            double w  = optNum(a,4,0)*s;
            if (w <= 0) w = 2*hd;                 // corniere a ailes egales
            double hw = w/2, t = optNum(a,5,0)*s;
            double rf = optNum(a,6,0)*s, re = optNum(a,7,0)*s;
            slope(8);
            if (hd <= 0 || hw <= 0 || t <= 0 || t >= 2*hw || t >= 2*hd) return false;
            p = {{-hw,-hd},{hw,-hd},{hw,-hd+t},{-hw+t,-hd+t},{-hw+t,hd},{-hw,hd}};
            r = {{3,rf},{2,re},{4,re}};
            return true;
        }
        if (e.type == "IFCTSHAPEPROFILEDEF" && a.size() >= 7) {
            // 3=Depth 4=FlangeWidth 5=WebThickness 6=FlangeThickness
            // 7=FilletRadius 8=FlangeEdgeRadius 9=WebEdgeRadius 10/11=slopes
            double hd = optNum(a,3,0)*s/2, hb = optNum(a,4,0)*s/2;
            double tw = optNum(a,5,0)*s,   tf = optNum(a,6,0)*s;
            double rf = optNum(a,7,0)*s, rfe = optNum(a,8,0)*s, rwe = optNum(a,9,0)*s;
            slope(10); slope(11);
            if (hd <= 0 || hb <= 0 || tw <= 0 || tf <= 0 || tw >= 2*hb || tf >= 2*hd)
                return false;
            double hw = tw/2, yt = hd-tf;
            p = {{ hw,-hd},{ hw,yt},{ hb,yt},{ hb,hd},
                 {-hb, hd},{-hb,yt},{-hw,yt},{-hw,-hd}};
            r = {{1,rf},{6,rf},{2,rfe},{5,rfe},{0,rwe},{7,rwe}};
            return true;
        }
        if (e.type == "IFCUSHAPEPROFILEDEF" && a.size() >= 7) {
            // 3=Depth 4=FlangeWidth 5=WebThickness 6=FlangeThickness
            // 7=FilletRadius 8=EdgeRadius 9=FlangeSlope
            double hd = optNum(a,3,0)*s/2, hb = optNum(a,4,0)*s/2;
            double tw = optNum(a,5,0)*s,   tf = optNum(a,6,0)*s;
            double rf = optNum(a,7,0)*s,   re = optNum(a,8,0)*s;
            slope(9);
            if (hd <= 0 || hb <= 0 || tw <= 0 || tf <= 0 || tw >= 2*hb || 2*tf >= 2*hd)
                return false;
            double xw = -hb+tw, yb = -hd+tf, yt = hd-tf;
            p = {{-hb,-hd},{hb,-hd},{hb,yb},{xw,yb},{xw,yt},{hb,yt},{hb,hd},{-hb,hd}};
            r = {{3,rf},{4,rf},{2,re},{5,re}};
            return true;
        }
        return false;
    }

    // IfcCartesianTransformationOperator2D : Axis1 porte X, Axis2 porte Y.
    // Le miroir des profils AISC passe par la — Axis1 = (-1,0) — et un miroir a
    // un determinant negatif : gp_Trsf l accepte (echelle negative), mais une
    // echelle non uniforme, non. D ou le repli sur gp_GTrsf.
    TopoDS_Shape applyOperator2D(uint32_t op, const TopoDS_Shape& in) {
        const Ent* o = get(op);
        if (!o || in.IsNull()) return in;
        double ax = 1, ay = 0, bx = 0, by = 1, ox = 0, oy = 0;
        if (!o->args.empty() && refOf(o->args[0])) {
            const Ent* d = get(refOf(o->args[0]));
            if (d && !d->args.empty()) {
                auto v = numsOf(d->args[0]);
                if (v.size() >= 2 && (v[0] || v[1])) { ax = v[0]; ay = v[1]; }
            }
        }
        bool hasY = false;
        if (o->args.size() > 1 && refOf(o->args[1])) {
            const Ent* d = get(refOf(o->args[1]));
            if (d && !d->args.empty()) {
                auto v = numsOf(d->args[0]);
                if (v.size() >= 2 && (v[0] || v[1])) { bx = v[0]; by = v[1]; hasY = true; }
            }
        }
        if (!hasY) { bx = -ay; by = ax; }          // Y deduit de X, comme la norme
        if (o->args.size() > 2 && refOf(o->args[2])) pnt2(refOf(o->args[2]), ox, oy);
        double k1 = optNum(o->args, 3, 1.0);
        if (k1 == 0) k1 = 1.0;
        double k2 = k1;
        if (o->type == "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM")
            k2 = optNum(o->args, 4, k1);
        if (k2 == 0) k2 = k1;
        double m[3][4] = {{ax*k1, bx*k2, 0, ox},
                          {ay*k1, by*k2, 0, oy},
                          {0,     0,     1, 0}};
        try {
            gp_Trsf t;
            t.SetValues(m[0][0],m[0][1],m[0][2],m[0][3],
                        m[1][0],m[1][1],m[1][2],m[1][3],
                        m[2][0],m[2][1],m[2][2],m[2][3]);
            return BRepBuilderAPI_Transform(in, t, Standard_True).Shape();
        } catch (...) {}
        try {
            gp_GTrsf g;
            g.SetValue(1,1,m[0][0]); g.SetValue(1,2,m[0][1]); g.SetValue(1,3,m[0][2]);
            g.SetValue(2,1,m[1][0]); g.SetValue(2,2,m[1][1]); g.SetValue(2,3,m[1][2]);
            g.SetValue(3,1,m[2][0]); g.SetValue(3,2,m[2][1]); g.SetValue(3,3,m[2][2]);
            g.SetTranslationPart(gp_XYZ(ox, oy, 0));
            return BRepBuilderAPI_GTransform(in, g, Standard_True).Shape();
        } catch (...) { unsupported["operator2d-failed"]++; }
        return in;
    }

    // IfcCenterLineProfileDef : une ligne moyenne et une epaisseur. Le contour
    // exact d une polyligne epaissie, c est la ligne decalee de t/2 a gauche,
    // puis de t/2 a droite en sens inverse ; aux sommets, l onglet. Exact pour
    // une polyligne — pas une approximation.
    bool centreLineFace(const Ent& e, TopoDS_Face& out) {
        if (e.args.size() < 4) return false;
        const Ent* c = get(refOf(e.args[2]));
        if (!c || c->type != "IFCPOLYLINE" || c->args.empty()) {
            unsupported[std::string("centerline-curve:") + (c ? std::string(c->type) : "?")]++;
            return false;
        }
        double half = numOf(e.args[3]) * s / 2.0;
        if (half <= 0) return false;
        std::vector<gp_Pnt2d> q;
        for (uint32_t pid : refsOf(c->args[0])) {
            double x, y; pnt2(pid, x, y);
            if (!q.empty() && std::fabs(q.back().X()-x) < 1e-9 && std::fabs(q.back().Y()-y) < 1e-9)
                continue;
            q.emplace_back(x, y);
        }
        if (q.size() < 2) return false;
        size_t n = q.size();
        std::vector<gp_Pnt2d> off(n);
        auto seg = [&](size_t i, size_t j, double& dx, double& dy) {
            dx = q[j].X() - q[i].X(); dy = q[j].Y() - q[i].Y();
            double L = std::hypot(dx, dy);
            if (L > 1e-12) { dx /= L; dy /= L; }
        };
        for (size_t i = 0; i < n; i++) {
            double n1x, n1y, n2x, n2y, dx, dy;
            if (i > 0)     { seg(i-1, i, dx, dy); n1x = -dy; n1y = dx; } else { n1x = n1y = 0; }
            if (i + 1 < n) { seg(i, i+1, dx, dy); n2x = -dy; n2y = dx; } else { n2x = n2y = 0; }
            if (i == 0)      { n1x = n2x; n1y = n2y; }
            if (i + 1 == n)  { n2x = n1x; n2y = n1y; }
            double mx = n1x + n2x, my = n1y + n2y;
            double L = std::hypot(mx, my);
            if (L < 1e-9) {                        // demi-tour : l onglet diverge
                unsupported["centerline-reversal"]++;
                mx = n1x; my = n1y; L = 1.0;
            }
            mx /= L; my /= L;
            double cosv = mx*n1x + my*n1y;         // 1 en ligne droite
            double k = (std::fabs(cosv) < 0.2) ? 5.0 : 1.0/cosv;
            off[i] = gp_Pnt2d(mx*half*k, my*half*k);
        }
        std::vector<gp_Pnt2d> contour;
        for (size_t i = 0; i < n; i++)
            contour.emplace_back(q[i].X() + off[i].X(), q[i].Y() + off[i].Y());
        for (size_t i = n; i-- > 0; )
            contour.emplace_back(q[i].X() - off[i].X(), q[i].Y() - off[i].Y());
        return outlineFace(contour, {}, out);
    }

    bool profileFace(uint32_t i, TopoDS_Face& out, int depth = 0) {
        const Ent* e = get(i);
        if (!e || depth > 8) return false;

        // profils derives : le parent, puis l operateur (miroir, rotation...)
        if (e->type == "IFCDERIVEDPROFILEDEF" || e->type == "IFCMIRROREDPROFILEDEF") {
            if (e->args.size() < 3) return false;
            TopoDS_Face par;
            if (!profileFace(refOf(e->args[2]), par, depth + 1)) return false;
            TopoDS_Shape f;
            if (e->type == "IFCMIRROREDPROFILEDEF") {
                // L operateur est DERIVE dans la norme : il n est pas dans le
                // fichier. C est un miroir sur l axe Y du parent, x -> -x.
                gp_Trsf t; t.SetMirror(gp_Ax1(gp_Pnt(0,0,0), gp_Dir(0,1,0)));
                f = BRepBuilderAPI_Transform(par, t, Standard_True).Shape();
            } else {
                f = applyOperator2D(refOf(e->args[3]), par);
            }
            if (f.IsNull() || f.ShapeType() != TopAbs_FACE) return false;
            out = TopoDS::Face(f);
            return true;
        }
        if (e->type == "IFCCENTERLINEPROFILEDEF") return centreLineFace(*e, out);
        {
            std::vector<gp_Pnt2d> op;
            std::vector<std::pair<size_t,double>> orad;
            if (standardOutline(*e, op, orad)) {
                TopoDS_Face f;
                if (!outlineFace(op, orad, f)) return false;
                return placeProfile(f, e->args.size() > 2 ? refOf(e->args[2]) : 0u, out);
            }
        }
        TopoDS_Wire outer;
        std::vector<TopoDS_Wire> inners;
        uint32_t pos = 0;
        if (e->type == "IFCRECTANGLEPROFILEDEF" && e->args.size() >= 5) {
            double hx = numOf(e->args[3]) * s / 2.0, hy = numOf(e->args[4]) * s / 2.0;
            BRepBuilderAPI_MakePolygon mp;
            mp.Add(gp_Pnt(-hx,-hy,0)); mp.Add(gp_Pnt(hx,-hy,0));
            mp.Add(gp_Pnt(hx, hy,0)); mp.Add(gp_Pnt(-hx, hy,0));
            mp.Close();
            if (!mp.IsDone()) return false;
            outer = mp.Wire(); pos = refOf(e->args[2]);
        } else if (e->type == "IFCCIRCLEPROFILEDEF" && e->args.size() >= 4) {
            double r = numOf(e->args[3]) * s;
            if (r <= 0) return false;
            gp_Circ c(gp_Ax2(gp_Pnt(0,0,0), gp_Dir(0,0,1)), r);
            outer = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(c).Edge()).Wire();
            pos = refOf(e->args[2]);
        } else if (e->type == "IFCRECTANGLEHOLLOWPROFILEDEF" && e->args.size() >= 6) {
            double hx = numOf(e->args[3]) * s / 2.0, hy = numOf(e->args[4]) * s / 2.0;
            double t  = numOf(e->args[5]) * s;
            auto rect = [](double ax, double ay) {
                BRepBuilderAPI_MakePolygon m;
                m.Add(gp_Pnt(-ax,-ay,0)); m.Add(gp_Pnt(ax,-ay,0));
                m.Add(gp_Pnt(ax, ay,0)); m.Add(gp_Pnt(-ax, ay,0));
                m.Close(); return m;
            };
            auto mo = rect(hx, hy);
            if (!mo.IsDone()) return false;
            outer = mo.Wire(); pos = refOf(e->args[2]);
            if (t > 0 && hx - t > 0 && hy - t > 0) {
                auto mi = rect(hx - t, hy - t);
                if (mi.IsDone()) inners.push_back(mi.Wire());
            }
        } else if (e->type == "IFCCIRCLEHOLLOWPROFILEDEF" && e->args.size() >= 5) {
            double r = numOf(e->args[3]) * s, t = numOf(e->args[4]) * s;
            if (r <= 0) return false;
            outer = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(
                        gp_Circ(gp_Ax2(gp_Pnt(0,0,0), gp_Dir(0,0,1)), r)).Edge()).Wire();
            pos = refOf(e->args[2]);
            if (t > 0 && r - t > 0)
                inners.push_back(BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(
                        gp_Circ(gp_Ax2(gp_Pnt(0,0,0), gp_Dir(0,0,1)), r - t)).Edge()).Wire());
        } else if ((e->type == "IFCARBITRARYCLOSEDPROFILEDEF" ||
                    e->type == "IFCARBITRARYPROFILEDEFWITHVOIDS") && e->args.size() >= 3) {
            if (!wireOfCurve(refOf(e->args[2]), outer)) return false;
            if (e->type == "IFCARBITRARYPROFILEDEFWITHVOIDS" && e->args.size() > 3)
                for (uint32_t v : refsOf(e->args[3])) {
                    TopoDS_Wire w;
                    if (wireOfCurve(v, w)) inners.push_back(w);
                }
        } else { unsupported[std::string("profile:") + std::string(e->type)]++; return false; }

        // AJOUTER UN TROU A UNE FACE QUI N'EXISTE PAS = SEGFAULT.
        // BRepBuilderAPI_MakeFace::Add ne verifie PAS son propre etat : il passe
        // droit a BRepLib_MakeFace::Add, qui appelle TopoDS_Builder::Add sur la
        // face en cours. Si le contour exterieur a echoue — degenere, non plan,
        // aire nulle — cette face est NULLE, et OCCT dereference dans le vide.
        // Le try/catch autour ne sert a rien : un dereferencement nul est un
        // signal, pas une exception C++. Le moteur meurt, pas l'import.
        // Constate sur ARK_NordicLCA_Housing_Concrete_As-Built_Revit.ifc
        // (80 Mo, 328 593 IfcIndexedPolygonalFace) : SIGSEGV apres 40 s, pile
        //   TopoDS_Builder::Add <- BRepLib_MakeFace::Add <- polyFace
        // sur une face a 4 sommets portant 2 contours interieurs.
        // La regle, pour les trois endroits qui posent des trous : verifier
        // IsDone() AVANT le premier Add, et APRES chacun — un Add peut echouer
        // a son tour et laisser le suivant sur une face invalide.
        BRepBuilderAPI_MakeFace mf(outer, Standard_True);
        if (!mf.IsDone()) return false;
        for (TopoDS_Wire& w : inners) {
            w.Reverse();
            mf.Add(w);
            if (!mf.IsDone()) return false;
        }
        return placeProfile(mf.Face(), pos, out);
    }

    // Pose le profil dans son IfcAxis2Placement2D. Partage par TOUS les profils :
    // les normalises passent par le meme chemin que les arbitraires.
    bool placeProfile(const TopoDS_Shape& in, uint32_t pos, TopoDS_Face& out) {
        TopoDS_Shape f = in;
        const Ent* pe = get(pos);
        if (pe && !pe->args.empty()) {                   // IfcAxis2Placement2D
            double ox, oy; pnt2(refOf(pe->args[0]), ox, oy);
            double dx = 1, dy = 0;
            if (pe->args.size() > 1 && refOf(pe->args[1])) {
                const Ent* de = get(refOf(pe->args[1]));
                if (de && !de->args.empty()) {
                    auto v = numsOf(de->args[0]);
                    if (v.size() >= 2 && (v[0] || v[1])) { dx = v[0]; dy = v[1]; }
                }
            }
            double ang = std::atan2(dy, dx);
            if (ox != 0 || oy != 0 || ang != 0) {
                gp_Trsf tr;
                tr.SetValues(std::cos(ang), -std::sin(ang), 0, ox,
                             std::sin(ang),  std::cos(ang), 0, oy,
                             0, 0, 1, 0);
                f = BRepBuilderAPI_Transform(f, tr, Standard_True).Shape();
            }
        }
        if (f.IsNull() || f.ShapeType() != TopAbs_FACE) return false;
        out = TopoDS::Face(f);
        return true;
    }

    // ── LE CHEMIN MAILLAGE : un jeu de faces rendu tel qu'il est ecrit ───────
    // Voir le bandeau de namespace tri. Ici on ne construit AUCUNE TopoDS_Face :
    // on lit les sommets, on garde l'identite que le fichier leur donne, on
    // triangule ce qui a plus de trois cotes, et c'est fini. Pas de couture,
    // pas de mailleur, pas de noyau CAD — donc ni les triangles en trop, ni les
    // minutes perdues, ni la face nulle qui faisait tomber le moteur.
    struct Mesh {
        std::vector<float> pos;                 // x,y,z entrelaces, en mm
        std::vector<uint32_t> idx;
        bool empty() const { return idx.size() < 3 || pos.size() < 9; }
    };

    int nMeshDirect = 0, nMeshTriFail = 0, nMeshFan = 0, nMeshNoHole = 0;

    // Ajoute un sommet transforme, rend son indice. `key` est l'identite que le
    // FICHIER donne au sommet (numero d'entite, ou rang dans une liste de
    // points) : deux facettes qui citent la meme chose partagent le sommet.
    // C'est plus juste qu'une soudure par coordonnees — et c'est gratuit.
    static uint32_t meshVertex(Mesh& m, std::unordered_map<uint64_t,uint32_t>& map,
                               uint64_t key, const gp_Pnt& p, const gp_Trsf& t) {
        auto it = map.find(key);
        if (it != map.end()) return it->second;
        gp_Pnt q = p.Transformed(t);
        uint32_t n = (uint32_t)(m.pos.size() / 3);
        m.pos.push_back((float)q.X()); m.pos.push_back((float)q.Y()); m.pos.push_back((float)q.Z());
        map.emplace(key, n);
        return n;
    }

    // Une facette : contour + trous, en indices DEJA places dans m.pos.
    void meshFace(Mesh& m, const std::vector<uint32_t>& loop,
                  const std::vector<std::vector<uint32_t>>& voids) {
        if (loop.size() < 3) return;
        if (loop.size() == 3 && voids.empty()) {
            if (loop[0] == loop[1] || loop[1] == loop[2] || loop[0] == loop[2]) return;
            m.idx.push_back(loop[0]); m.idx.push_back(loop[1]); m.idx.push_back(loop[2]);
            return;
        }
        size_t before = m.idx.size();
        if (tri::faceToTriangles(m.pos, loop, voids, m.idx) && m.idx.size() > before) return;
        m.idx.resize(before);
        // Dernier recours avant de perdre la facette : la triangulariser SANS
        // ses trous. Le percement disparait, mais le mur reste. Une facette
        // approximative vaut mieux qu'un trou beant, et le compteur le dit.
        if (!voids.empty()) {
            nMeshNoHole++;
            if (tri::faceToTriangles(m.pos, loop, {}, m.idx) && m.idx.size() > before) return;
            m.idx.resize(before);
        }
        // Repli en eventail. Faux sur un polygone tres concave, mais une facette
        // approximative vaut mieux qu'un trou dans le mur, et le compteur le dit.
        nMeshTriFail++;
        if (!voids.empty()) return;              // avec trous, l'eventail serait absurde
        nMeshFan++;
        for (size_t k = 1; k + 1 < loop.size(); k++) {
            if (loop[0] == loop[k] || loop[k] == loop[k+1] || loop[0] == loop[k+1]) continue;
            m.idx.push_back(loop[0]); m.idx.push_back(loop[k]); m.idx.push_back(loop[k+1]);
        }
    }

    // IfcClosedShell / IfcOpenShell : des IfcFace bornees par des IfcPolyLoop.
    void meshShell(uint32_t sid, const gp_Trsf& t, Mesh& m,
                   std::unordered_map<uint64_t,uint32_t>& map) {
        const Ent* sh = get(sid);
        if (!sh || sh->args.empty()) return;
        for (uint32_t fid : refsOf(sh->args[0])) {
            const Ent* fe = get(fid);
            if (!fe || fe->args.empty()) continue;
            std::vector<uint32_t> outer;
            std::vector<std::vector<uint32_t>> voids;
            bool haveOuter = false;
            for (uint32_t bid : refsOf(fe->args[0])) {
                const Ent* be = get(bid);
                if (!be || be->args.empty()) continue;
                const Ent* lp = get(refOf(be->args[0]));
                if (!lp || lp->type != "IFCPOLYLOOP" || lp->args.empty()) continue;
                std::vector<uint32_t> ring;
                for (uint32_t pid : refsOf(lp->args[0]))
                    ring.push_back(meshVertex(m, map, pid, pnt(pid), t));
                // Orientation du bord : .F. signifie parcours inverse.
                if (be->args.size() > 1 && isEnum(be->args[1], "F"))
                    std::reverse(ring.begin(), ring.end());
                if (ring.size() < 3) continue;
                if (be->type == "IFCFACEOUTERBOUND" || !haveOuter) {
                    if (haveOuter) voids.push_back(outer);
                    outer = ring; haveOuter = true;
                } else voids.push_back(ring);
            }
            if (haveOuter) meshFace(m, outer, voids);
        }
    }

    // Rend true si l'item EST un maillage et a pu etre lu tel quel.
    bool meshOfItem(uint32_t i, const gp_Trsf& t, Mesh& m,
                    std::unordered_map<uint64_t,uint32_t>& map, int depth = 0) {
        const Ent* e = get(i);
        if (!e || depth > 12) return false;

        if (e->type == "IFCMAPPEDITEM" && !e->args.empty()) {
            const Ent* rm = get(refOf(e->args[0]));           // IfcRepresentationMap
            if (!rm || rm->args.size() < 2) return false;
            gp_Trsf tr = t;
            if (uint32_t org = refOf(rm->args[0])) {
                gp_Trsf o; o.SetTransformation(axis3(org), gp_Ax3());
                tr = tr * o;
            }
            if (e->args.size() > 1) {
                const Ent* op = get(refOf(e->args[1]));       // operateur 3D
                if (op && !op->args.empty()) {
                    gp_Dir ax(1,0,0), ay(0,1,0);
                    if (refOf(op->args[0])) ax = dirv(refOf(op->args[0]), 1, 0, 0);
                    if (op->args.size() > 1 && refOf(op->args[1])) ay = dirv(refOf(op->args[1]), 0, 1, 0);
                    gp_Pnt og = op->args.size() > 2 && refOf(op->args[2]) ? pnt(refOf(op->args[2])) : gp_Pnt();
                    double sc = (op->args.size() > 3) ? numOf(op->args[3], 1.0) : 1.0;
                    try {
                        gp_Dir az(gp_Vec(ax).Crossed(gp_Vec(ay)));
                        gp_Trsf t2; t2.SetTransformation(gp_Ax3(og, az, ax), gp_Ax3());
                        if (std::fabs(sc - 1.0) > 1e-9) t2.SetScaleFactor(sc);
                        tr = t2 * tr;
                    } catch (...) { return false; }
                }
            }
            const Ent* src = get(refOf(rm->args[1]));         // representation source
            if (!src || src->args.size() < 4) return false;
            bool any = false;
            for (uint32_t it : refsOf(src->args[3]))
                if (meshOfItem(it, tr, m, map, depth + 1)) any = true;
            return any;
        }

        if (e->type == "IFCTRIANGULATEDFACESET" && e->args.size() >= 4) {
            const auto* pts = pointList(refOf(e->args[0]));
            if (!pts || pts->empty()) return false;
            std::vector<std::vector<uint32_t>> tris;
            intGroups(e->args[3], tris);
            if (tris.empty()) return false;
            uint64_t base = ((uint64_t)refOf(e->args[0]) << 32);
            for (const auto& tr3 : tris) {
                if (tr3.size() < 3) continue;
                std::vector<uint32_t> ring;
                bool ok = true;
                for (uint32_t k : tr3) {
                    if (k == 0 || k > pts->size()) { ok = false; break; }
                    const auto& p = (*pts)[k - 1];
                    ring.push_back(meshVertex(m, map, base | k, gp_Pnt(p[0], p[1], p[2]), t));
                }
                if (ok) meshFace(m, ring, {});
            }
            nMeshDirect++;
            return !m.empty();
        }

        if (e->type == "IFCPOLYGONALFACESET" && e->args.size() >= 3) {
            const auto* pts = pointList(refOf(e->args[0]));
            if (!pts || pts->empty()) return false;
            uint64_t base = ((uint64_t)refOf(e->args[0]) << 32);
            auto ringOf = [&](const std::vector<uint32_t>& g, std::vector<uint32_t>& ring) {
                for (uint32_t k : g) {
                    if (k == 0 || k > pts->size()) return false;
                    const auto& p = (*pts)[k - 1];
                    ring.push_back(meshVertex(m, map, base | k, gp_Pnt(p[0], p[1], p[2]), t));
                }
                return true;
            };
            for (uint32_t fid : refsOf(e->args[2])) {
                const Ent* fe = get(fid);
                if (!fe || fe->args.empty()) continue;
                std::vector<std::vector<uint32_t>> g;
                intGroups(fe->args[0], g);
                if (g.empty() || g[0].size() < 3) continue;
                std::vector<uint32_t> outer;
                if (!ringOf(g[0], outer)) continue;
                std::vector<std::vector<uint32_t>> voids;
                if (fe->type == "IFCINDEXEDPOLYGONALFACEWITHVOIDS" && fe->args.size() > 1) {
                    std::vector<std::vector<uint32_t>> vg;
                    intGroups(fe->args[1], vg);
                    for (const auto& v : vg) {
                        if (v.size() < 3) continue;
                        std::vector<uint32_t> r;
                        if (ringOf(v, r)) voids.push_back(std::move(r));
                    }
                }
                meshFace(m, outer, voids);
            }
            nMeshDirect++;
            return !m.empty();
        }

        if (e->type == "IFCFACETEDBREP" && !e->args.empty()) {
            meshShell(refOf(e->args[0]), t, m, map);
            nMeshDirect++;
            return !m.empty();
        }
        if (e->type == "IFCSHELLBASEDSURFACEMODEL" && !e->args.empty()) {
            for (uint32_t sid : refsOf(e->args[0])) meshShell(sid, t, m, map);
            nMeshDirect++;
            return !m.empty();
        }
        return false;                                     // pas un maillage
    }

    // ── B-REP AVANCE (IfcAdvancedBrep) ───────────────────────────────────────
    // Meme structure que l ADVANCED_BREP_SHAPE_REPRESENTATION de STEP : des faces
    // portees par de vraies surfaces — plans, tores, NURBS — et bordees par des
    // aretes portees par de vraies courbes. Rien a voir avec l IfcFacetedBrep,
    // qui n est qu une soupe de polygones.
    //
    // Tabel_Chairs.ifc, 31 produits, est a 100 % la-dessus : 278 IfcAdvancedFace
    // sur 114 IfcRationalBSplineSurfaceWithKnots, 98 IfcPlane et 66
    // IfcToroidalSurface, avec 538 IfcEdgeCurve sur des IfcLine, IfcCircle,
    // IfcEllipse et IfcBSplineCurveWithKnots.
    //
    // UNITES : les points de controle sont des LONGUEURS (a l echelle), les
    // noeuds et les poids sont des PARAMETRES (jamais a l echelle). Confondre les
    // deux ne casse pas la compilation, ca tord la surface.
    std::unordered_map<uint32_t, TopoDS_Vertex> vtxCache;
    std::unordered_map<uint32_t, TopoDS_Edge> edgeCache;

    // Poles d une B-spline : leur nombre se DEDUIT des multiplicites, et la
    // formule n est pas la meme selon que la courbe est periodique ou bridee.
    // On ne devine pas : on teste les deux et on prend celle qui tombe juste.
    static bool splineKind(size_t nPoles, int degree,
                           const std::vector<int>& mult, bool& periodic) {
        long tot = 0;
        for (int m : mult) tot += m;
        if ((long)nPoles == tot - degree - 1) { periodic = false; return true; }
        if (!mult.empty() && (long)nPoles == tot - mult.back()) { periodic = true; return true; }
        return false;
    }

    Handle(Geom_Curve) curve3d(uint32_t i) {
        const Ent* e = get(i);
        if (!e) return Handle(Geom_Curve)();
        try {
            if (e->type == "IFCLINE" && e->args.size() >= 2) {
                gp_Pnt p = pnt(refOf(e->args[0]));
                const Ent* v = get(refOf(e->args[1]));     // IfcVector
                gp_Dir d(1, 0, 0);
                if (v && !v->args.empty()) d = dirv(refOf(v->args[0]), 1, 0, 0);
                return new Geom_Line(p, d);
            }
            if (e->type == "IFCCIRCLE" && e->args.size() >= 2) {
                double r = numOf(e->args[1]) * s;
                if (r <= 0) return Handle(Geom_Curve)();
                return new Geom_Circle(axis3(refOf(e->args[0])).Ax2(), r);
            }
            if (e->type == "IFCELLIPSE" && e->args.size() >= 3) {
                double a1 = numOf(e->args[1]) * s, a2 = numOf(e->args[2]) * s;
                if (a1 <= 0 || a2 <= 0) return Handle(Geom_Curve)();
                gp_Ax2 ax = axis3(refOf(e->args[0])).Ax2();
                // OCCT exige grand axe >= petit axe. IFC ne l exige pas : si
                // SemiAxis1 < SemiAxis2, on tourne le repere d un quart de tour
                // plutot que d echanger les valeurs, ce qui donnerait une ellipse
                // juste mais orientee de travers.
                if (a1 < a2) { ax.Rotate(gp_Ax1(ax.Location(), ax.Direction()), M_PI/2); std::swap(a1, a2); }
                return new Geom_Ellipse(ax, a1, a2);
            }
            if (e->type == "IFCBSPLINECURVEWITHKNOTS" ||
                e->type == "IFCRATIONALBSPLINECURVEWITHKNOTS") {
                if (e->args.size() < 7) return Handle(Geom_Curve)();
                int deg = (int)numOf(e->args[0]);
                std::vector<uint32_t> cp = refsOf(e->args[1]);
                std::vector<double> mu = numsOf(e->args[5]);
                std::vector<double> kn = numsOf(e->args[6]);
                if (deg < 1 || cp.size() < 2 || kn.empty() || mu.size() != kn.size())
                    return Handle(Geom_Curve)();
                std::vector<int> mult(mu.begin(), mu.end());
                bool per = false;
                if (!splineKind(cp.size(), deg, mult, per)) {
                    unsupported["bspline-curve-knots"]++;
                    return Handle(Geom_Curve)();
                }
                TColgp_Array1OfPnt P(1, (int)cp.size());
                for (size_t k = 0; k < cp.size(); k++) P.SetValue((int)k+1, pnt(cp[k]));
                TColStd_Array1OfReal K(1, (int)kn.size());
                TColStd_Array1OfInteger Mu(1, (int)mult.size());
                for (size_t k = 0; k < kn.size(); k++) {
                    K.SetValue((int)k+1, kn[k]);           // parametres : pas d echelle
                    Mu.SetValue((int)k+1, mult[k]);
                }
                if (e->type == "IFCRATIONALBSPLINECURVEWITHKNOTS" && e->args.size() > 7) {
                    std::vector<double> w = numsOf(e->args[7]);
                    if (w.size() == cp.size()) {
                        TColStd_Array1OfReal W(1, (int)w.size());
                        for (size_t k = 0; k < w.size(); k++) W.SetValue((int)k+1, w[k]);
                        return new Geom_BSplineCurve(P, W, K, Mu, deg, per);
                    }
                }
                return new Geom_BSplineCurve(P, K, Mu, deg, per);
            }
            if (e->type == "IFCTRIMMEDCURVE" && !e->args.empty()) {
                // Les sommets de l arete portent deja la coupe : la courbe de base
                // suffit, et elle evite de traduire IfcTrimmingSelect.
                return curve3d(refOf(e->args[0]));
            }
            if (e->type == "IFCPOLYLINE" && !e->args.empty()) {
                std::vector<uint32_t> p = refsOf(e->args[0]);
                if (p.size() < 2) return Handle(Geom_Curve)();
                TColgp_Array1OfPnt P(1, (int)p.size());
                for (size_t k = 0; k < p.size(); k++) P.SetValue((int)k+1, pnt(p[k]));
                TColStd_Array1OfReal K(1, (int)p.size());
                TColStd_Array1OfInteger Mu(1, (int)p.size());
                for (size_t k = 0; k < p.size(); k++) { K.SetValue((int)k+1, (double)k); Mu.SetValue((int)k+1, 1); }
                Mu.SetValue(1, 2); Mu.SetValue((int)p.size(), 2);
                return new Geom_BSplineCurve(P, K, Mu, 1, Standard_False);
            }
        } catch (...) {}
        unsupported[std::string("edge-curve:") + std::string(e->type)]++;
        return Handle(Geom_Curve)();
    }

    Handle(Geom_Surface) surface(uint32_t i) {
        const Ent* e = get(i);
        if (!e) return Handle(Geom_Surface)();
        try {
            if (e->type == "IFCPLANE" && !e->args.empty())
                return new Geom_Plane(axis3(refOf(e->args[0])));
            if (e->type == "IFCCYLINDRICALSURFACE" && e->args.size() >= 2)
                return new Geom_CylindricalSurface(axis3(refOf(e->args[0])),
                                                   numOf(e->args[1]) * s);
            if (e->type == "IFCSPHERICALSURFACE" && e->args.size() >= 2)
                return new Geom_SphericalSurface(axis3(refOf(e->args[0])),
                                                 numOf(e->args[1]) * s);
            if (e->type == "IFCCONICALSURFACE" && e->args.size() >= 3)
                return new Geom_ConicalSurface(axis3(refOf(e->args[0])),
                                               numOf(e->args[2]) * gAngleToRad,
                                               numOf(e->args[1]) * s);
            if (e->type == "IFCTOROIDALSURFACE" && e->args.size() >= 3)
                return new Geom_ToroidalSurface(axis3(refOf(e->args[0])),
                                                numOf(e->args[1]) * s,
                                                numOf(e->args[2]) * s);
            if (e->type == "IFCSURFACEOFLINEAREXTRUSION" && e->args.size() >= 4) {
                Handle(Geom_Curve) c = curve3d(refOf(e->args[0]));
                if (c.IsNull()) return Handle(Geom_Surface)();
                return new Geom_SurfaceOfLinearExtrusion(c, dirv(refOf(e->args[2]), 0, 0, 1));
            }
            if (e->type == "IFCSURFACEOFREVOLUTION" && e->args.size() >= 3) {
                Handle(Geom_Curve) c = curve3d(refOf(e->args[0]));
                const Ent* ap = get(refOf(e->args[2]));    // IfcAxis1Placement
                if (c.IsNull() || !ap || ap->args.empty()) return Handle(Geom_Surface)();
                gp_Pnt o = pnt(refOf(ap->args[0]));
                gp_Dir d = ap->args.size() > 1 ? dirv(refOf(ap->args[1]), 0, 0, 1) : gp_Dir(0, 0, 1);
                return new Geom_SurfaceOfRevolution(c, gp_Ax1(o, d));
            }
            if (e->type == "IFCRECTANGULARTRIMMEDSURFACE" && !e->args.empty())
                return surface(refOf(e->args[0]));         // les bords donnent la coupe
            if (e->type == "IFCCURVEBOUNDEDPLANE" && !e->args.empty())
                return surface(refOf(e->args[0]));
            if (e->type == "IFCBSPLINESURFACEWITHKNOTS" ||
                e->type == "IFCRATIONALBSPLINESURFACEWITHKNOTS") {
                if (e->args.size() < 11) return Handle(Geom_Surface)();
                int du = (int)numOf(e->args[0]), dv = (int)numOf(e->args[1]);
                std::vector<std::vector<uint32_t>> cp;
                refGroups(e->args[2], cp);                 // [u][v]
                std::vector<double> mu = numsOf(e->args[7]), mv = numsOf(e->args[8]);
                std::vector<double> ku = numsOf(e->args[9]), kv = numsOf(e->args[10]);
                if (du < 1 || dv < 1 || cp.size() < 2 || cp[0].size() < 2 ||
                    mu.size() != ku.size() || mv.size() != kv.size())
                    return Handle(Geom_Surface)();
                size_t nu = cp.size(), nv = cp[0].size();
                for (const auto& row : cp) if (row.size() != nv) return Handle(Geom_Surface)();
                std::vector<int> Mu(mu.begin(), mu.end()), Mv(mv.begin(), mv.end());
                bool pu = false, pv = false;
                if (!splineKind(nu, du, Mu, pu) || !splineKind(nv, dv, Mv, pv)) {
                    unsupported["bspline-surface-knots"]++;
                    return Handle(Geom_Surface)();
                }
                TColgp_Array2OfPnt P(1, (int)nu, 1, (int)nv);
                for (size_t a = 0; a < nu; a++)
                    for (size_t b = 0; b < nv; b++)
                        P.SetValue((int)a+1, (int)b+1, pnt(cp[a][b]));
                TColStd_Array1OfReal KU(1, (int)ku.size()), KV(1, (int)kv.size());
                TColStd_Array1OfInteger MU(1, (int)Mu.size()), MV(1, (int)Mv.size());
                for (size_t k = 0; k < ku.size(); k++) { KU.SetValue((int)k+1, ku[k]); MU.SetValue((int)k+1, Mu[k]); }
                for (size_t k = 0; k < kv.size(); k++) { KV.SetValue((int)k+1, kv[k]); MV.SetValue((int)k+1, Mv[k]); }
                if (e->type == "IFCRATIONALBSPLINESURFACEWITHKNOTS" && e->args.size() > 12) {
                    std::vector<std::vector<double>> wg;
                    numGroups(e->args[12], wg);
                    if (wg.size() == nu && wg[0].size() == nv) {
                        TColStd_Array2OfReal W(1, (int)nu, 1, (int)nv);
                        bool okw = true;
                        for (size_t a = 0; a < nu && okw; a++) {
                            if (wg[a].size() != nv) { okw = false; break; }
                            for (size_t b = 0; b < nv; b++) W.SetValue((int)a+1, (int)b+1, wg[a][b]);
                        }
                        if (okw) return new Geom_BSplineSurface(P, W, KU, KV, MU, MV, du, dv, pu, pv);
                    }
                    unsupported["bspline-surface-weights"]++;
                }
                return new Geom_BSplineSurface(P, KU, KV, MU, MV, du, dv, pu, pv);
            }
        } catch (...) {}
        unsupported[std::string("face-surface:") + std::string(e->type)]++;
        return Handle(Geom_Surface)();
    }

    TopoDS_Vertex vertexOf(uint32_t i) {
        auto c = vtxCache.find(i);
        if (c != vtxCache.end()) return c->second;
        TopoDS_Vertex v;
        const Ent* e = get(i);
        if (e && !e->args.empty()) {
            uint32_t p = refOf(e->args[0]);                // IfcVertexPoint -> point
            try { v = BRepBuilderAPI_MakeVertex(pnt(p)); } catch (...) {}
        }
        vtxCache.emplace(i, v);
        return v;
    }

    // Une IfcEdgeCurve est PARTAGEE par ses deux faces. La construire une seule
    // fois et la reutiliser, c est ce qui donne une topologie deja cousue plutot
    // qu un tas de faces a recoller.
    bool edgeOf(uint32_t i, TopoDS_Edge& out) {
        auto c = edgeCache.find(i);
        if (c != edgeCache.end()) { out = c->second; return !out.IsNull(); }
        TopoDS_Edge ed;
        const Ent* e = get(i);
        if (e && e->args.size() >= 3) {
            TopoDS_Vertex a = vertexOf(refOf(e->args[0]));
            TopoDS_Vertex b = vertexOf(refOf(e->args[1]));
            Handle(Geom_Curve) cu = curve3d(refOf(e->args[2]));
            bool same = e->args.size() < 4 || !isEnum(e->args[3], "F");
            if (!cu.IsNull() && !a.IsNull() && !b.IsNull()) {
                try {
                    // SameSense faux : la courbe va a l envers de l arete.
                    BRepBuilderAPI_MakeEdge me(cu, same ? a : b, same ? b : a);
                    if (me.IsDone()) ed = me.Edge();
                } catch (...) {}
                if (ed.IsNull() && a.IsSame(b)) {
                    try {                                   // arete fermee : cercle entier
                        BRepBuilderAPI_MakeEdge me(cu);
                        if (me.IsDone()) ed = me.Edge();
                    } catch (...) {}
                }
                if (ed.IsNull()) unsupported["edge-build-failed"]++;
            }
        }
        edgeCache.emplace(i, ed);
        out = ed;
        return !ed.IsNull();
    }

    bool edgeLoop(uint32_t i, TopoDS_Wire& out) {
        const Ent* e = get(i);
        if (!e || e->args.empty()) return false;
        BRepBuilderAPI_MakeWire mw;
        int n = 0;
        for (uint32_t oe : refsOf(e->args[0])) {
            const Ent* o = get(oe);                        // IfcOrientedEdge
            if (!o || o->args.size() < 3) continue;
            TopoDS_Edge ed;
            if (!edgeOf(refOf(o->args[2]), ed)) continue;
            if (o->args.size() > 3 && isEnum(o->args[3], "F")) ed.Reverse();
            try { mw.Add(ed); n++; } catch (...) {}
        }
        if (!n || !mw.IsDone()) return false;
        out = mw.Wire();
        return true;
    }

    bool advancedFace(uint32_t i, TopoDS_Face& out) {
        const Ent* e = get(i);
        if (!e || e->args.size() < 3) return false;
        Handle(Geom_Surface) su = surface(refOf(e->args[1]));
        if (su.IsNull()) return false;
        bool same = !isEnum(e->args[2], "F");
        std::vector<std::pair<TopoDS_Wire,bool>> bounds;   // fil, est-exterieur
        for (uint32_t bid : refsOf(e->args[0])) {
            const Ent* b = get(bid);
            if (!b || b->args.empty()) continue;
            TopoDS_Wire w;
            if (!edgeLoop(refOf(b->args[0]), w)) continue;
            if (b->args.size() > 1 && isEnum(b->args[1], "F")) w.Reverse();
            bounds.push_back({w, b->type == "IFCFACEOUTERBOUND"});
        }
        if (bounds.empty()) return false;
        // Le bord exterieur d abord : BRepBuilderAPI_MakeFace prend le premier
        // pour contour et les suivants pour trous.
        std::stable_sort(bounds.begin(), bounds.end(),
                         [](const std::pair<TopoDS_Wire,bool>& a,
                            const std::pair<TopoDS_Wire,bool>& b) { return a.second > b.second; });
        try {
            BRepBuilderAPI_MakeFace mf(su, bounds[0].first, Standard_False);
            if (!mf.IsDone()) { unsupported["advanced-face-build"]++; return false; }
            for (size_t k = 1; k < bounds.size(); k++) mf.Add(bounds[k].first);
            if (!mf.IsDone()) { unsupported["advanced-face-hole"]++; return false; }
            TopoDS_Face f = mf.Face();
            if (!same) f.Reverse();
            // Les courbes 2D manquent : sans elles, ni la couture ni la
            // tessellation ne savent ou passent les bords sur la surface.
            try {
                ShapeFix_Face fx(f);
                fx.FixAddNaturalBoundMode() = Standard_False;
                fx.FixMissingSeamMode() = Standard_True;
                fx.Perform();
                if (!fx.Face().IsNull()) f = fx.Face();
            } catch (...) {}
            out = f;
            return true;
        } catch (...) { unsupported["advanced-face-build"]++; }
        return false;
    }

    TopoDS_Shape advancedBrep(uint32_t i) {
        const Ent* e = get(i);
        if (!e || e->args.empty()) return TopoDS_Shape();
        std::vector<uint32_t> shells;
        shells.push_back(refOf(e->args[0]));               // Outer
        if (e->type == "IFCADVANCEDBREPWITHVOIDS" && e->args.size() > 1)
            for (uint32_t v : refsOf(e->args[1])) shells.push_back(v);
        std::vector<TopoDS_Face> faces;
        for (uint32_t sid : shells) {
            const Ent* sh = get(sid);
            if (!sh || sh->args.empty()) continue;
            for (uint32_t fid : refsOf(sh->args[0])) {
                TopoDS_Face f;
                if (advancedFace(fid, f)) faces.push_back(f);
                else nAdvFaceFail++;
            }
        }
        if (faces.empty()) return TopoDS_Shape();
        nAdvFace += (int)faces.size();
        return sew(faces, true);
    }

    // ── coques polygonales ───────────────────────────────────────────────────
    void facesOfShell(uint32_t i, std::vector<TopoDS_Face>& out) {
        const Ent* sh = get(i);
        if (!sh || sh->args.empty()) return;
        for (uint32_t fid : refsOf(sh->args[0])) {
            const Ent* fe = get(fid);
            if (!fe || fe->args.empty()) continue;
            TopoDS_Wire outer; bool haveOuter = false;
            std::vector<TopoDS_Wire> inners;
            for (uint32_t b : refsOf(fe->args[0])) {
                const Ent* be = get(b);
                if (!be || be->args.empty()) continue;
                const Ent* lp = get(refOf(be->args[0]));
                if (!lp || lp->type != "IFCPOLYLOOP" || lp->args.empty()) continue;
                std::vector<gp_Pnt> pts;
                for (uint32_t p : refsOf(lp->args[0])) pts.push_back(pnt(p));
                if (pts.size() < 3) continue;
                if (be->args.size() > 1 && !isEnum(be->args[1], "T")) std::reverse(pts.begin(), pts.end());
                BRepBuilderAPI_MakePolygon mp;
                for (const gp_Pnt& p : pts) mp.Add(p);
                mp.Close();
                if (!mp.IsDone()) continue;
                if (be->type == "IFCFACEOUTERBOUND" || !haveOuter) { outer = mp.Wire(); haveOuter = true; }
                else inners.push_back(mp.Wire());
            }
            if (!haveOuter) continue;
            try {
                // meme garde que dans polyFace : voir le commentaire la-bas.
                BRepBuilderAPI_MakeFace mf(outer, Standard_True);
                bool alive = mf.IsDone();
                for (TopoDS_Wire& w : inners) {
                    if (!alive) break;
                    w.Reverse();
                    mf.Add(w);
                    alive = mf.IsDone();
                }
                if (alive) out.push_back(mf.Face());
            } catch (...) {}
        }
    }

    // Coudre les faces, puis en faire un solide. Le piege : BRepBuilderAPI_Sewing
    // referme la coque mais ne REORIENTE rien, et un IfcFacetedBrep n est pas tenu
    // d ecrire ses faces dans un sens coherent. On obtient alors un solide dont
    // l encombrement est juste au millimetre pres et dont le volume est faux d un
    // facteur 17 : les faces retournees comptent en negatif dans l integrale.
    //
    // MESURE qui l a montre — la meme sculpture AISC existe en parametrique et en
    // brep explicite, produit par produit, meme numerotation. Poutre #2930,
    // W12x26 :
    //     parametrique  2 046 340 mm3   boite 164,8 x 419,1 x 310,4
    //     brep, avant   117 979 mm3     boite 164,8 x 419,1 x 300,7
    // L arithmetique tranche : 7,568 in2 de section x 419 mm = 2 045 000 mm3.
    // C etait la lecture du brep qui mentait, pas le profil.
    //
    // Consequence reelle : la tessellation ne se soucie pas de l orientation des
    // faces, et nasrep::repair reoriente de toute facon par composante. Mais le
    // percement des IfcRelVoidsElement, lui, passe par BRepAlgoAPI_Cut AVANT la
    // tessellation, et un booleen sur un solide incoherent rend n importe quoi.
    TopoDS_Shape sew(const std::vector<TopoDS_Face>& faces, bool wantSolid) {
        if (faces.empty()) return TopoDS_Shape();
        BRepBuilderAPI_Sewing sw(1e-4 * s);
        for (const TopoDS_Face& f : faces) sw.Add(f);
        sw.Perform();
        TopoDS_Shape r = sw.SewedShape();
        nSewed++;
        if (sw.NbFreeEdges() > 0) { nOpen++; freeEdges += sw.NbFreeEdges(); }
        if (r.IsNull() || !wantSolid) return r;

        // UN IfcClosedShell PEUT EN CONTENIR PLUSIEURS. Les poutres du fichier
        // AISC brep en sont la preuve : un W12x26 y est ecrit en 42 faces, soit
        // TROIS prismes accoles — aile basse, ame, aile haute — dans une seule
        // IfcClosedShell. Ne prendre que la premiere coque, c est perdre les deux
        // autres. On fait donc un solide PAR coque, et un compose s il y en a
        // plusieurs.
        //
        // CE QUE CELA NE REGLE PAS, et je l ai mesure : sur ce fichier, 6 breps
        // sur 146 se separent vraiment ; pour les autres, les prismes se TOUCHENT
        // et la couture les fond en une seule coque a cloisons internes. Un tel
        // solide est non-manifold, et son integrale de volume s annule en partie —
        // 117 979 mm3 la ou l arithmetique en donne 2 022 000.
        // Consequence reelle : AUCUNE sur le rendu. La tessellation couvre toutes
        // les faces et nasrep::repair coupe justement les aretes non-manifold et
        // reoriente par composante. Seuls un BRepAlgoAPI_Cut sur un tel brep — un
        // percement dans une piece facettee, cas absent du corpus — et la mesure
        // de volume au niveau OCCT s en trouvent fausses. Le volume juste se prend
        // sur les triangles, pas ici.
        std::vector<TopoDS_Shell> shells;
        for (TopExp_Explorer ex(r, TopAbs_SHELL); ex.More(); ex.Next())
            shells.push_back(TopoDS::Shell(ex.Current()));
        if (shells.empty()) return r;

        std::vector<TopoDS_Shape> solids;
        for (TopoDS_Shell sh : shells) {
            try {
                ShapeFix_Shell fs(sh);
                fs.FixFaceOrientation(sh);        // coherence entre faces voisines
                if (!fs.Shell().IsNull()) sh = fs.Shell();
            } catch (...) { unsupported["shell-orient-failed"]++; }
            try {
                BRepBuilderAPI_MakeSolid ms(sh);
                if (!ms.IsDone()) { solids.push_back(sh); continue; }
                TopoDS_Solid sol = ms.Solid();
                BRepLib::OrientClosedSolid(sol);  // et le sens global, matiere dedans
                solids.push_back(sol);
            } catch (...) { solids.push_back(sh); }
        }
        if (solids.empty()) return r;
        if (solids.size() == 1) return solids[0];
        TopoDS_Compound cp;
        BRep_Builder bb;
        bb.MakeCompound(cp);
        for (const TopoDS_Shape& x : solids) bb.Add(cp, x);
        nMultiShell++;
        return cp;
    }

    // ── jeux de faces tesseles (IFC4) ────────────────────────────────────────
    // C est par la qu arrive tout ce qui vient d un maillage : mobilier,
    // scans, exports depuis un modeleur polygonal. Absent du premier fichier
    // teste (ArchiCAD n en emet pas), present partout ailleurs des qu on sort
    // du B-Rep parametrique.
    std::unordered_map<uint32_t, std::vector<std::array<double,3>>> ptListCache;

    const std::vector<std::array<double,3>>* pointList(uint32_t i) {
        auto c = ptListCache.find(i);
        if (c != ptListCache.end()) return &c->second;
        const Ent* e = get(i);
        if (!e || e->args.empty()) return nullptr;
        std::vector<std::array<double,3>> pts;
        ptGroups(e->args[0], pts);
        for (auto& p : pts) { p[0] *= s; p[1] *= s; p[2] *= s; }
        auto r = ptListCache.emplace(i, std::move(pts));
        return &r.first->second;
    }

    // Une face polygonale -> TopoDS_Face, indices a partir de 1.
    // ── garder les facettes telles qu elles sont ecrites ─────────────────────
    // Un IfcTriangulatedFaceSet EST deja un maillage. Le reconstruire en B-Rep
    // puis le rendre au mailleur d OCCT ne peut que le degrader : aller-retour
    // mesure sur AC20-FZK-Haus — 19 858 triangles a l ecriture, 20 168 a la
    // relecture, 17 corps sur 104 modifies, tous des portes et des fenetres, et
    // cinq qui perdaient leur etancheite au passage.
    //
    // OCCT porte la reponse dans son propre mecanisme, et MEDUSA l avait deja
    // mesure le 17/09 : BRepMesh_Deflection::IsConsistent garde une face DEJA
    // maillee plus finement que la demande (remailler a 0,5 un tore maille a
    // 0,01 rendait exactement les memes 8 346 triangles). Une facette plane a
    // une deflexion nulle : elle est coherente avec n importe quelle demande.
    // On attache donc la triangulation d origine et le mailleur passe son
    // chemin — plus fidele ET plus rapide.
    //
    // APRES la couture, pas avant : BRepBuilderAPI_Sewing reconstruit les faces
    // pour partager leurs aretes, et ce qui etait accroche avant n y survit pas.
    //
    // CE QUI RESTE, mesure et non corrige. L aller-retour de la maison passe de
    // 20 168 a 20 096 triangles pour 19 858 ecrits, et de 95 a 97 corps fermes
    // sur 104. Le reliquat ne vient pas du mailleur : la couture cree des
    // jonctions en T — le sommet d une facette voisine coupe l arete d une
    // autre — et la face coupee a des lors quatre sommets de contour au lieu de
    // trois, donc deux triangles au lieu d un. 19 858 facettes rendent ainsi
    // 20 270 triangles attaches, et c est GEOMETRIQUEMENT juste : une face en T
    // qu on laisserait a un seul triangle serait fissuree.
    // Le seul aller-retour exact au triangle pres demanderait de ne pas passer
    // par le B-Rep du tout pour un jeu de faces — de porter le maillage brut
    // jusqu au NSTP. C est un changement du pipeline de MEDUSA, pas du lecteur.
    void attachFacetTriangulation(const TopoDS_Shape& sh) {
        if (sh.IsNull()) return;
        BRep_Builder bb;
        for (TopExp_Explorer ex(sh, TopAbs_FACE); ex.More(); ex.Next()) {
            const TopoDS_Face& f = TopoDS::Face(ex.Current());
            TopLoc_Location loc;
            if (!BRep_Tool::Triangulation(f, loc).IsNull()) continue;
            // une facette n a qu un contour : une face a trous n en est pas une
            int nw = 0;
            for (TopExp_Explorer wx(f, TopAbs_WIRE); wx.More(); wx.Next()) nw++;
            if (nw != 1) { nAttachSkipWires++; continue; }
            TopoDS_Wire w = BRepTools::OuterWire(f);
            if (w.IsNull()) { nAttachSkipWire++; continue; }
            std::vector<gp_Pnt> v;
            try {
                for (BRepTools_WireExplorer we(w, f); we.More(); we.Next()) {
                    v.push_back(BRep_Tool::Pnt(we.CurrentVertex()));
                    if (v.size() > 64) break;             // ce n est plus une facette
                }
            } catch (...) { nAttachThrow++; continue; }
            if (v.size() < 3 || v.size() > 64) { nAttachSkipN++; continue; }
            try {
                gp_Trsf inv = loc.Transformation().Inverted();
                Handle(Poly_Triangulation) T =
                    new Poly_Triangulation((int)v.size(), (int)v.size() - 2, Standard_False);
                for (size_t k = 0; k < v.size(); k++)
                    T->SetNode((int)k + 1, v[k].Transformed(inv));
                // eventail depuis le premier sommet : le contour donne l ordre,
                // donc l orientation suit celle de la face.
                for (size_t k = 1; k + 1 < v.size(); k++)
                    T->SetTriangle((int)k, Poly_Triangle(1, (int)k + 1, (int)k + 2));
                // Pas zero : la passe de budget de MEDUSA remaille avec
                // AllowQualityDecrease, et exige alors une deflexion du meme
                // ordre que la demande. Une valeur minuscule mais positive est
                // « plus fine que tout » sans etre degeneree.
                T->Deflection(1e-7);
                bb.UpdateFace(f, T);
                nAttached++;
            } catch (...) { nAttachThrow++; }
        }
    }

    bool polyFace(const std::vector<std::array<double,3>>& pts,
                  const std::vector<uint32_t>& idx,
                  const std::vector<std::vector<uint32_t>>& voids,
                  TopoDS_Face& out) {
        if (idx.size() < 3) return false;
        BRepBuilderAPI_MakePolygon mp;
        for (uint32_t k : idx) {
            if (k == 0 || k > pts.size()) return false;
            const auto& p = pts[k - 1];
            mp.Add(gp_Pnt(p[0], p[1], p[2]));
        }
        mp.Close();
        if (!mp.IsDone()) return false;
        try {
            // AJOUTER UN TROU A UNE FACE QUI N'EXISTE PAS = SEGFAULT.
            // BRepBuilderAPI_MakeFace::Add ne verifie PAS son propre etat : il passe
            // droit a BRepLib_MakeFace::Add, qui appelle TopoDS_Builder::Add sur la
            // face en cours. Si le contour exterieur a echoue — degenere, non plan,
            // aire nulle — cette face est NULLE, et OCCT dereference dans le vide.
            // Le try/catch autour ne sert a rien : un dereferencement nul est un
            // signal, pas une exception C++. Le moteur meurt, pas l'import.
            // Constate sur ARK_NordicLCA_Housing_Concrete_As-Built_Revit.ifc
            // (80 Mo, 328 593 IfcIndexedPolygonalFace) : SIGSEGV apres 40 s, pile
            //   TopoDS_Builder::Add <- BRepLib_MakeFace::Add <- polyFace
            // sur une face a 4 sommets portant 2 contours interieurs.
            // La regle, pour les trois endroits qui posent des trous : verifier
            // IsDone() AVANT le premier Add, et APRES chacun — un Add peut echouer
            // a son tour et laisser le suivant sur une face invalide.
            BRepBuilderAPI_MakeFace mf(mp.Wire(), Standard_True);
            if (!mf.IsDone()) return false;
            for (const auto& vd : voids) {
                if (vd.size() < 3) continue;
                BRepBuilderAPI_MakePolygon mv;
                bool ok = true;
                for (uint32_t k : vd) {
                    if (k == 0 || k > pts.size()) { ok = false; break; }
                    const auto& p = pts[k - 1];
                    mv.Add(gp_Pnt(p[0], p[1], p[2]));
                }
                if (!ok) continue;
                mv.Close();
                if (!mv.IsDone()) continue;
                TopoDS_Wire w = mv.Wire(); w.Reverse();
                mf.Add(w);
                if (!mf.IsDone()) return false;
            }
            if (!mf.IsDone()) return false;
            out = mf.Face();
            return true;
        } catch (...) { return false; }
    }

    // ── demi-espaces ─────────────────────────────────────────────────────────
    // OCCT sait faire un demi-espace infini, mais un boolean contre un infini est
    // fragile. On materialise une boite qui deborde largement la piece a couper.
    TopoDS_Shape halfSpace(uint32_t i, const TopoDS_Shape& refShape) {
        const Ent* e = get(i);
        if (!e || e->args.size() < 2) return TopoDS_Shape();
        const Ent* pl = get(refOf(e->args[0]));
        if (!pl || pl->type != "IFCPLANE" || pl->args.empty()) {
            unsupported[std::string("halfspace-base:") + (pl ? std::string(pl->type) : "?")]++;
            return TopoDS_Shape();
        }
        // LE SENS DU DRAPEAU. ISO 16739, IfcHalfSpaceSolid.AgreementFlag :
        //   « The agreement flag is TRUE if the normal to the BaseSurface points
        //     AWAY FROM the material of the IfcHalfSpaceSolid. »
        // Donc .T. = matiere du cote NEGATIF de la normale, .F. = cote positif.
        // C est l inverse de ce que je croyais, et personne ne me l aurait dit :
        // les deux fichiers de maison n emploient que .T., le fichier AISC que
        // .F., et chacun pris seul a l air plausible.
        //
        // Ce qui l a revele : la meme sculpture AISC existe en parametrique et en
        // brep, produit par produit. Le membre #2983, WT4x12, est une extrusion
        // de 1118 mm coupee par un plan place a son extremite. Le brep le donne
        // long de 1100,8 mm ; je rendais un moignon de 17,6 mm, soit exactement
        // le complement. Les deux coupes .F. du fichier enlevaient 93 % et 98,7 %
        // de leur operande.
        bool agree = isEnum(e->args[1], "T");
        gp_Ax3 ax = axis3(refOf(pl->args[0]));
        Bnd_Box bb; BRepBndLib::Add(refShape, bb, Standard_False);
        if (bb.IsVoid()) return TopoDS_Shape();
        gp_Pnt lo = bb.CornerMin(), hi = bb.CornerMax();
        double diag = std::max(std::max(hi.X()-lo.X(), hi.Y()-lo.Y()), hi.Z()-lo.Z()) * 4.0 + 1000.0;
        TopoDS_Shape box = BRepPrimAPI_MakeBox(gp_Pnt(-diag, -diag, agree ? -diag : 0.0),
                                               2*diag, 2*diag, diag).Shape();
        gp_Trsf tr; tr.SetTransformation(ax, gp_Ax3());
        box = BRepBuilderAPI_Transform(box, tr, Standard_True).Shape();
        if (e->type == "IFCPOLYGONALBOUNDEDHALFSPACE" && e->args.size() > 3) {
            TopoDS_Wire w;
            if (wireOfCurve(refOf(e->args[3]), w)) {
                BRepBuilderAPI_MakeFace mf(w, Standard_True);
                if (mf.IsDone()) {
                    TopoDS_Shape pr = BRepPrimAPI_MakePrism(mf.Face(), gp_Vec(0, 0, 2*diag)).Shape();
                    gp_Trsf t2; t2.SetTransformation(axis3(refOf(e->args[2])), gp_Ax3());
                    gp_Trsf mv; mv.SetTranslation(gp_Vec(0, 0, -diag));
                    pr = BRepBuilderAPI_Transform(pr, t2 * mv, Standard_True).Shape();
                    try {
                        BRepAlgoAPI_Common cc(box, pr); cc.Build();
                        if (cc.IsDone()) box = cc.Shape();
                    } catch (...) {}
                }
            }
        }
        return box;
    }

    // ── balayage le long d une courbe ────────────────────────────────────────
    // IfcSurfaceCurveSweptAreaSolid : un profil promene le long d une directrice
    // qui REPOSE sur une surface de reference. Dans la sculpture AISC, ce sont
    // huit barres rondes cintrees : profil circulaire de 0,5 in, directrice en
    // polyligne a huit points, surface de reference un plan.
    //
    // La directrice peut etre ecrite en 2D : ses coordonnees sont alors les
    // PARAMETRES (u,v) de la surface de reference, pas des coordonnees du monde.
    // C est le cas ici — le plan a son Z en (0,1,0) — et prendre les deux nombres
    // pour du x,y mettrait la barre a plat dans le mauvais plan.
    bool directrixWire(uint32_t cid, uint32_t surfId, TopoDS_Wire& out, gp_Dir& binorm) {
        const Ent* c = get(cid);
        if (!c) return false;
        Handle(Geom_Surface) ref;
        if (surfId) ref = surface(surfId);
        std::vector<gp_Pnt> p3;
        if (c->type == "IFCPOLYLINE" && !c->args.empty()) {
            for (uint32_t pid : refsOf(c->args[0])) {
                const Ent* pe = get(pid);
                if (!pe || pe->args.empty()) continue;
                auto v = numsOf(pe->args[0]);
                if (v.size() >= 3) p3.push_back(gp_Pnt(v[0]*s, v[1]*s, v[2]*s));
                else if (v.size() == 2 && !ref.IsNull()) p3.push_back(ref->Value(v[0]*s, v[1]*s));
                else if (v.size() == 2) p3.push_back(gp_Pnt(v[0]*s, v[1]*s, 0));
            }
        } else {
            Handle(Geom_Curve) g = curve3d(cid);
            if (g.IsNull()) return false;
            try {
                BRepBuilderAPI_MakeEdge me(g);
                if (!me.IsDone()) return false;
                BRepBuilderAPI_MakeWire mw(me.Edge());
                if (!mw.IsDone()) return false;
                out = mw.Wire();
            } catch (...) { return false; }
            binorm = gp_Dir(0, 0, 1);
            return true;
        }
        // doublons : une arete de longueur nulle fait echouer tout le balayage
        for (size_t k = 1; k < p3.size(); )
            if (p3[k].Distance(p3[k-1]) < 1e-7) p3.erase(p3.begin() + k); else k++;
        if (p3.size() < 2) return false;
        try {
            BRepBuilderAPI_MakePolygon mp;
            for (const gp_Pnt& q : p3) mp.Add(q);
            if (!mp.IsDone()) return false;
            out = mp.Wire();
        } catch (...) { return false; }

        binorm = gp_Dir(0, 0, 1);
        if (!ref.IsNull()) {
            Handle(Geom_Plane) pl = Handle(Geom_Plane)::DownCast(ref);
            if (!pl.IsNull()) binorm = pl->Position().Direction();
            else unsupported["swept-reference-surface-not-plane"]++;
        }
        return true;
    }

    TopoDS_Shape sweptAlongCurve(const Ent& e) {
        // 0 SweptArea, 1 Position, 2 Directrix, 3 StartParam, 4 EndParam,
        // 5 ReferenceSurface (ou FixedReference)
        if (e.args.size() < 6) return TopoDS_Shape();
        TopoDS_Wire spine;
        gp_Dir binorm(0, 0, 1);
        bool fixedRef = (e.type == "IFCFIXEDREFERENCESWEPTAREASOLID");
        if (!directrixWire(refOf(e.args[2]), fixedRef ? 0u : refOf(e.args[5]), spine, binorm))
            return TopoDS_Shape();
        if (fixedRef) binorm = dirv(refOf(e.args[5]), 0, 0, 1);
        TopoDS_Face prof;
        if (!profileFace(refOf(e.args[0]), prof)) return TopoDS_Shape();
        TopoDS_Wire pw;
        for (TopExp_Explorer ex(prof, TopAbs_WIRE); ex.More(); ex.Next()) { pw = TopoDS::Wire(ex.Current()); break; }
        if (pw.IsNull()) return TopoDS_Shape();
        try {
            BRepOffsetAPI_MakePipeShell ps(spine);
            ps.SetMode(binorm);                    // binormale fixe = normale du plan
            ps.Add(pw, Standard_True, Standard_True);   // au contact, redresse
            ps.Build();
            if (!ps.IsDone()) { unsupported["swept-pipe-failed"]++; return TopoDS_Shape(); }
            ps.MakeSolid();
            TopoDS_Shape sh = ps.Shape();
            if (sh.IsNull()) return sh;
            if (uint32_t pos = refOf(e.args[1])) {
                gp_Trsf tr; tr.SetTransformation(axis3(pos), gp_Ax3());
                sh = BRepBuilderAPI_Transform(sh, tr, Standard_True).Shape();
            }
            return sh;
        } catch (...) { unsupported["swept-pipe-failed"]++; }
        return TopoDS_Shape();
    }

    // IfcSweptDiskSolid : un tube. Meme machine, profil implicite.
    TopoDS_Shape sweptDisk(const Ent& e) {
        if (e.args.size() < 2) return TopoDS_Shape();
        TopoDS_Wire spine;
        gp_Dir binorm(0, 0, 1);
        if (!directrixWire(refOf(e.args[0]), 0, spine, binorm)) return TopoDS_Shape();
        double r = numOf(e.args[1]) * s;
        double ri = e.args.size() > 2 ? numOf(e.args[2]) * s : 0.0;
        if (r <= 0) return TopoDS_Shape();
        auto tube = [&](double rad) -> TopoDS_Shape {
            gp_Circ ci(gp_Ax2(gp_Pnt(0,0,0), gp_Dir(0,0,1)), rad);
            TopoDS_Wire w = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(ci).Edge()).Wire();
            BRepOffsetAPI_MakePipeShell ps(spine);
            ps.SetMode(Standard_True);             // repere de Frenet
            ps.Add(w, Standard_True, Standard_True);
            ps.Build();
            if (!ps.IsDone()) return TopoDS_Shape();
            ps.MakeSolid();
            return ps.Shape();
        };
        try {
            TopoDS_Shape o = tube(r);
            if (o.IsNull()) { unsupported["swept-disk-failed"]++; return o; }
            if (ri > 0 && ri < r) {
                TopoDS_Shape in = tube(ri);
                if (!in.IsNull()) {
                    BRepAlgoAPI_Cut cu(o, in); cu.Build();
                    if (cu.IsDone()) return cu.Shape();
                }
            }
            return o;
        } catch (...) { unsupported["swept-disk-failed"]++; }
        return TopoDS_Shape();
    }

    // ── items de representation ──────────────────────────────────────────────
    TopoDS_Shape item(uint32_t i, int depth = 0) {
        const Ent* e = get(i);
        if (!e || depth > 12) return TopoDS_Shape();
        try {
            if (e->type == "IFCEXTRUDEDAREASOLID" && e->args.size() >= 4) {
                TopoDS_Face f;
                if (!profileFace(refOf(e->args[0]), f)) return TopoDS_Shape();
                gp_Dir d = dirv(refOf(e->args[2]), 0, 0, 1);
                double h = numOf(e->args[3]) * s;
                if (h == 0) return TopoDS_Shape();
                TopoDS_Shape sh = BRepPrimAPI_MakePrism(f, gp_Vec(d.X()*h, d.Y()*h, d.Z()*h)).Shape();
                if (uint32_t pos = refOf(e->args[1])) {
                    gp_Trsf tr; tr.SetTransformation(axis3(pos), gp_Ax3());
                    sh = BRepBuilderAPI_Transform(sh, tr, Standard_True).Shape();
                }
                return sh;
            }
            if (e->type == "IFCFACETEDBREP" && !e->args.empty()) {
                std::vector<TopoDS_Face> fs; facesOfShell(refOf(e->args[0]), fs);
                return sew(fs, true);
            }
            if (e->type == "IFCADVANCEDBREP" || e->type == "IFCADVANCEDBREPWITHVOIDS")
                return advancedBrep(i);

            // ── primitives CSG (IfcCsgPrimitive3D) ───────────────────────────
            // Conventions d'origine VERIFIEES sur ISO 16739, parce qu'elles ne
            // sont PAS les memes d'une primitive a l'autre et qu'une erreur ici
            // deplace la piece d'une demi-hauteur sans rien casser d'autre :
            //   IfcBlock                 « one vertex at location », +X +Y +Z
            //   IfcRightCircularCone     « the center of the circular area being
            //                              the bottom face », apex a +Z
            //   IfcRightCircularCylinder « the origin is the center of the
            //                              bottom circular disk »
            //   IfcSphere                « the center of the sphere »
            // OCCT prend exactement les memes reperes, donc la traduction est
            // directe — a condition de ne pas les confondre.
            if (e->type == "IFCCSGSOLID" && !e->args.empty())
                return item(refOf(e->args[0]), depth + 1);
            if (e->type == "IFCBLOCK" && e->args.size() >= 4) {
                double dx = numOf(e->args[1]) * s, dy = numOf(e->args[2]) * s, dz = numOf(e->args[3]) * s;
                if (dx <= 0 || dy <= 0 || dz <= 0) return TopoDS_Shape();
                return BRepPrimAPI_MakeBox(axis3(refOf(e->args[0])).Ax2(), dx, dy, dz).Shape();
            }
            if (e->type == "IFCSPHERE" && e->args.size() >= 2) {
                double r = numOf(e->args[1]) * s;
                if (r <= 0) return TopoDS_Shape();
                return BRepPrimAPI_MakeSphere(axis3(refOf(e->args[0])).Ax2(), r).Shape();
            }
            if (e->type == "IFCRIGHTCIRCULARCONE" && e->args.size() >= 3) {
                double h = numOf(e->args[1]) * s, r = numOf(e->args[2]) * s;
                if (h <= 0 || r <= 0) return TopoDS_Shape();
                return BRepPrimAPI_MakeCone(axis3(refOf(e->args[0])).Ax2(), r, 0.0, h).Shape();
            }
            if (e->type == "IFCRIGHTCIRCULARCYLINDER" && e->args.size() >= 3) {
                double h = numOf(e->args[1]) * s, r = numOf(e->args[2]) * s;
                if (h <= 0 || r <= 0) return TopoDS_Shape();
                return BRepPrimAPI_MakeCylinder(axis3(refOf(e->args[0])).Ax2(), r, h).Shape();
            }
            if (e->type == "IFCRECTANGULARPYRAMID" && e->args.size() >= 4) {
                // Base a un COIN de l'origine comme IfcBlock, sommet au-dessus
                // du CENTRE de la base. Aucune primitive OCCT ne la donne : on
                // pose les cinq faces.
                double dx = numOf(e->args[1]) * s, dy = numOf(e->args[2]) * s, h = numOf(e->args[3]) * s;
                if (dx <= 0 || dy <= 0 || h <= 0) return TopoDS_Shape();
                gp_Trsf tr; tr.SetTransformation(axis3(refOf(e->args[0])), gp_Ax3());
                gp_Pnt b0(0,0,0), b1(dx,0,0), b2(dx,dy,0), b3(0,dy,0), ap(dx/2, dy/2, h);
                auto face = [&](std::initializer_list<gp_Pnt> pl) -> TopoDS_Face {
                    BRepBuilderAPI_MakePolygon mp;
                    for (const gp_Pnt& q : pl) mp.Add(q);
                    mp.Close();
                    if (!mp.IsDone()) return TopoDS_Face();
                    BRepBuilderAPI_MakeFace mf(mp.Wire(), Standard_True);
                    return mf.IsDone() ? mf.Face() : TopoDS_Face();
                };
                std::vector<TopoDS_Face> fs;
                for (auto f : { face({b0,b3,b2,b1}), face({b0,b1,ap}), face({b1,b2,ap}),
                                face({b2,b3,ap}),   face({b3,b0,ap}) })
                    if (!f.IsNull()) fs.push_back(f);
                if (fs.size() != 5) return TopoDS_Shape();
                TopoDS_Shape sh = sew(fs, true);
                if (sh.IsNull()) return sh;
                return BRepBuilderAPI_Transform(sh, tr, Standard_False).Shape();
            }
            if (e->type == "IFCSURFACECURVESWEPTAREASOLID" ||
                e->type == "IFCFIXEDREFERENCESWEPTAREASOLID")
                return sweptAlongCurve(*e);
            if (e->type == "IFCSWEPTDISKSOLID" || e->type == "IFCSWEPTDISKSOLIDPOLYGONAL")
                return sweptDisk(*e);
            if (e->type == "IFCSHELLBASEDSURFACEMODEL" && !e->args.empty()) {
                std::vector<TopoDS_Face> fs;
                for (uint32_t sid : refsOf(e->args[0])) facesOfShell(sid, fs);
                return sew(fs, false);
            }
            if (e->type == "IFCTRIANGULATEDFACESET" && e->args.size() >= 4) {
                const auto* pts = pointList(refOf(e->args[0]));
                if (!pts || pts->empty()) return TopoDS_Shape();
                std::vector<std::vector<uint32_t>> tris;
                intGroups(e->args[3], tris);
                if (tris.empty()) return TopoDS_Shape();
                bool closed = isEnum(e->args[2], "T");
                std::vector<TopoDS_Face> fs;
                fs.reserve(tris.size());
                TopoDS_Face f;
                for (const auto& t : tris)
                    if (polyFace(*pts, t, {}, f)) fs.push_back(f);
                TopoDS_Shape r = sew(fs, closed);
                attachFacetTriangulation(r);
                return r;
            }
            if (e->type == "IFCPOLYGONALFACESET" && e->args.size() >= 3) {
                const auto* pts = pointList(refOf(e->args[0]));
                if (!pts || pts->empty()) return TopoDS_Shape();
                bool closed = isEnum(e->args[1], "T");
                std::vector<TopoDS_Face> fs;
                TopoDS_Face f;
                for (uint32_t fid : refsOf(e->args[2])) {
                    const Ent* fe = get(fid);
                    if (!fe || fe->args.empty()) continue;
                    std::vector<std::vector<uint32_t>> g;
                    intGroups(fe->args[0], g);
                    if (g.empty()) continue;
                    std::vector<std::vector<uint32_t>> voids;
                    if (fe->type == "IFCINDEXEDPOLYGONALFACEWITHVOIDS" && fe->args.size() > 1)
                        intGroups(fe->args[1], voids);
                    if (polyFace(*pts, g[0], voids, f)) fs.push_back(f);
                }
                TopoDS_Shape r = sew(fs, closed);
                attachFacetTriangulation(r);
                return r;
            }
            if (e->type == "IFCREVOLVEDAREASOLID" && e->args.size() >= 4) {
                TopoDS_Face f;
                if (!profileFace(refOf(e->args[0]), f)) return TopoDS_Shape();
                const Ent* ax = get(refOf(e->args[2]));          // IfcAxis1Placement
                gp_Pnt o; gp_Dir d(0, 0, 1);
                if (ax && !ax->args.empty()) {
                    if (refOf(ax->args[0])) o = pnt(refOf(ax->args[0]));
                    if (ax->args.size() > 1 && refOf(ax->args[1])) d = dirv(refOf(ax->args[1]), 0, 0, 1);
                }
                double ang = numOf(e->args[3]) * gAngleToRad;
                if (ang == 0) return TopoDS_Shape();
                TopoDS_Shape sh = BRepPrimAPI_MakeRevol(f, gp_Ax1(o, d), ang).Shape();
                if (uint32_t pos = refOf(e->args[1])) {
                    gp_Trsf tr; tr.SetTransformation(axis3(pos), gp_Ax3());
                    sh = BRepBuilderAPI_Transform(sh, tr, Standard_True).Shape();
                }
                return sh;
            }
            if (e->type == "IFCMAPPEDITEM" && e->args.size() >= 2) {
                const Ent* src = get(refOf(e->args[0]));          // IfcRepresentationMap
                if (!src || src->args.size() < 2) return TopoDS_Shape();
                TopoDS_Shape sub = representation(refOf(src->args[1]), depth + 1);
                if (sub.IsNull()) return sub;
                gp_Trsf tr;
                if (uint32_t org = refOf(src->args[0])) tr.SetTransformation(axis3(org), gp_Ax3());
                const Ent* op = get(refOf(e->args[1]));           // IfcCartesianTransformationOperator3D
                if (op && op->args.size() >= 3) {
                    gp_Dir ax = refOf(op->args[0]) ? dirv(refOf(op->args[0]), 1, 0, 0) : gp_Dir(1, 0, 0);
                    gp_Dir ay = (op->args.size() > 1 && refOf(op->args[1])) ? dirv(refOf(op->args[1]), 0, 1, 0) : gp_Dir(0, 1, 0);
                    gp_Pnt og = (op->args.size() > 2 && refOf(op->args[2])) ? pnt(refOf(op->args[2])) : gp_Pnt();
                    double sc = (op->args.size() > 3) ? numOf(op->args[3], 1.0) : 1.0;
                    gp_Dir az(gp_Vec(ax).Crossed(gp_Vec(ay)));
                    gp_Trsf t2; t2.SetTransformation(gp_Ax3(og, az, ax), gp_Ax3());
                    if (std::fabs(sc - 1.0) > 1e-9) t2.SetScaleFactor(sc);
                    tr = t2 * tr;
                }
                return BRepBuilderAPI_Transform(sub, tr, Standard_False).Shape();
            }
            if ((e->type == "IFCBOOLEANCLIPPINGRESULT" || e->type == "IFCBOOLEANRESULT") && e->args.size() >= 3) {
                TopoDS_Shape first = item(refOf(e->args[1]), depth + 1);
                if (first.IsNull()) return first;
                uint32_t sid = refOf(e->args[2]);
                const Ent* se = get(sid);
                TopoDS_Shape sec;
                if (se && (se->type == "IFCHALFSPACESOLID" || se->type == "IFCPOLYGONALBOUNDEDHALFSPACE"))
                    sec = halfSpace(sid, first);
                else sec = item(sid, depth + 1);
                if (sec.IsNull()) return first;
                bool inter = e->args[0].find("INTERSECTION") != SV::npos;
                if (inter) { BRepAlgoAPI_Common a(first, sec); a.Build(); return a.IsDone() ? a.Shape() : first; }
                BRepAlgoAPI_Cut a(first, sec); a.Build();
                return a.IsDone() ? a.Shape() : first;
            }
            unsupported[std::string("item:") + std::string(e->type)]++;
        } catch (...) {
            unsupported[std::string("EXC:") + std::string(e->type)]++;
        }
        return TopoDS_Shape();
    }

    TopoDS_Shape representation(uint32_t i, int depth = 0) {
        const Ent* e = get(i);
        if (!e || e->args.size() < 4) return TopoDS_Shape();
        // On ne prend que 'Body' : Box/Axis/FootPrint/Annotation sont du 2D ou
        // des boites englobantes, importer l un ou l autre double les objets.
        if (depth == 0 && txtOf(e->args[1]) != "Body") return TopoDS_Shape();
        std::vector<TopoDS_Shape> items;
        for (uint32_t it : refsOf(e->args[3])) {
            TopoDS_Shape sh = item(it, depth);
            if (!sh.IsNull()) items.push_back(sh);
        }
        if (items.empty()) return TopoDS_Shape();
        if (items.size() == 1) return items[0];
        TopoDS_Compound c; BRep_Builder bb; bb.MakeCompound(c);
        for (auto& sh : items) bb.Add(c, sh);
        return c;
    }

    // ── produit complet, place dans le repere du projet ──────────────────────
    TopoDS_Shape productShape(uint32_t pid) {
        const Ent* p = get(pid);
        if (!p || p->args.size() < 7) return TopoDS_Shape();
        const Ent* pds = get(refOf(p->args[6]));
        if (!pds || pds->args.size() < 3) return TopoDS_Shape();
        std::vector<TopoDS_Shape> parts;
        for (uint32_t r : refsOf(pds->args[2])) {
            TopoDS_Shape sh = representation(r, 0);
            if (!sh.IsNull()) parts.push_back(sh);
        }
        if (parts.empty()) return TopoDS_Shape();
        TopoDS_Shape sh = parts[0];
        if (parts.size() > 1) {
            TopoDS_Compound c; BRep_Builder bb; bb.MakeCompound(c);
            for (auto& x : parts) bb.Add(c, x);
            sh = c;
        }
        // [22/09] Copy = FALSE, et ce n est pas une micro-optimisation.
        // Avec Copy = true, BRepBuilderAPI_Transform reconstruit la
        // geometrie et JETTE au passage les triangulations attachees aux
        // faces : mesure sur l aller-retour AC20-FZK-Haus, 19 858 facettes
        // attachees par attachFacetTriangulation, 0 survivantes.
        // Avec false, OCCT se contente de poser une TopLoc_Location quand
        // la transformation est un deplacement rigide — la triangulation
        // suit, et rien n est recalcule. Si la transformation porte une
        // mise a l echelle, OCCT repasse tout seul en copie (il teste
        // ScaleFactor contre TopLoc_Location::ScalePrec), donc le cas
        // des IfcCartesianTransformationOperator a facteur reste correct.
        // Le partage de TShape qui en resulte est deja prevu cote MEDUSA :
        // sa tessellation parallele verrouille justement par TShape.
        if (uint32_t plc = refOf(p->args[5])) {
            try { sh = BRepBuilderAPI_Transform(sh, placement(plc), Standard_False).Shape(); }
            catch (...) {}
        }
        return sh;
    }

    // ── decoupage d un produit PAR STYLE ─────────────────────────────────────
    // Une fenetre IFC, c est un dormant opaque ET un vitrage a 0,88 de
    // transparence, dans la meme representation. Rendre « la » couleur du
    // produit revient a rendre celle du premier item rencontre — le dormant — et
    // tout le vitrage du batiment ressort opaque. Mesure : 0 corps translucide
    // sur 784 avant ce decoupage.
    //
    // On aplatit donc la representation jusqu aux items FEUILLES, en composant
    // les transformations des IfcMappedItem au passage, puis on regroupe par
    // style. Un corps par style : le vitrage devient un objet a part, qu on peut
    // aussi masquer dans l arborescence.
    struct Leaf { uint32_t item; gp_Trsf trsf; };

    void flatten(uint32_t repId, const gp_Trsf& acc, std::vector<Leaf>& out, int depth = 0) {
        const Ent* e = get(repId);
        if (!e || e->args.size() < 4 || depth > 8) return;
        for (uint32_t it : refsOf(e->args[3])) {
            const Ent* ie = get(it);
            if (!ie) continue;
            if (ie->type == "IFCMAPPEDITEM" && ie->args.size() >= 2) {
                const Ent* src = get(refOf(ie->args[0]));
                if (!src || src->args.size() < 2) continue;
                gp_Trsf tr;
                if (uint32_t org = refOf(src->args[0])) tr.SetTransformation(axis3(org), gp_Ax3());
                const Ent* op = get(refOf(ie->args[1]));
                if (op && op->args.size() >= 3) {
                    gp_Dir ax = refOf(op->args[0]) ? dirv(refOf(op->args[0]), 1, 0, 0) : gp_Dir(1, 0, 0);
                    gp_Dir ay = (op->args.size() > 1 && refOf(op->args[1])) ? dirv(refOf(op->args[1]), 0, 1, 0) : gp_Dir(0, 1, 0);
                    gp_Pnt og = (op->args.size() > 2 && refOf(op->args[2])) ? pnt(refOf(op->args[2])) : gp_Pnt();
                    double sc = (op->args.size() > 3) ? numOf(op->args[3], 1.0) : 1.0;
                    try {
                        gp_Dir az(gp_Vec(ax).Crossed(gp_Vec(ay)));
                        gp_Trsf t2; t2.SetTransformation(gp_Ax3(og, az, ax), gp_Ax3());
                        if (std::fabs(sc - 1.0) > 1e-9) t2.SetScaleFactor(sc);
                        tr = t2 * tr;
                    } catch (...) {}
                }
                flatten(refOf(src->args[1]), acc * tr, out, depth + 1);
            } else {
                out.push_back(Leaf{it, acc});
            }
        }
    }

    // Style d un item feuille : sur lui, ou sur l une des faces de son brep.
    bool styleOfLeaf(uint32_t it, Style& out) const {
        auto s1 = styleOf.find(it);
        if (s1 != styleOf.end()) { out = s1->second; return true; }
        const Ent* ie = get(it);
        if (ie && ie->type == "IFCFACETEDBREP" && !ie->args.empty()) {
            const Ent* sh = get(refOf(ie->args[0]));
            if (sh && !sh->args.empty())
                for (uint32_t f : refsOf(sh->args[0])) {
                    auto s2 = styleOf.find(f);
                    if (s2 != styleOf.end()) { out = s2->second; return true; }
                }
        }
        return false;
    }

    // Une piece est SOIT une forme OCCT a tesseller, SOIT un maillage deja lu.
    // Les deux voyagent ensemble jusqu'au NSTP ; c'est le seul endroit du
    // pipeline qui doit savoir lequel des deux il tient.
    struct Piece { TopoDS_Shape shape; Style style; bool hasStyle = false;
                   Mesh mesh; bool isMesh = false; };

    // Concatene `src` dans `dst` en decalant ses indices.
    static void meshAppend(Mesh& dst, const Mesh& src) {
        uint32_t base = (uint32_t)(dst.pos.size() / 3);
        dst.pos.insert(dst.pos.end(), src.pos.begin(), src.pos.end());
        dst.idx.reserve(dst.idx.size() + src.idx.size());
        for (uint32_t k : src.idx) dst.idx.push_back(base + k);
    }

    // allowMesh = false quand le produit doit etre PERCE : un booleen se fait
    // sur une forme OCCT, pas sur un maillage. Les percements sont rares sur de
    // la geometrie tesselee — les exports Revit sortent deja decoupes — donc ce
    // repli coute peu et garde le resultat juste.
    void productPieces(uint32_t pid, std::vector<Piece>& out, bool allowMesh = true) {
        const Ent* p = get(pid);
        if (!p || p->args.size() < 7) return;
        const Ent* pds = get(refOf(p->args[6]));
        if (!pds || pds->args.size() < 3) return;
        std::vector<Leaf> leaves;
        for (uint32_t r : refsOf(pds->args[2])) {
            const Ent* re = get(r);
            if (!re || re->args.size() < 2 || txtOf(re->args[1]) != "Body") continue;
            flatten(r, gp_Trsf(), leaves);
        }
        if (leaves.empty()) return;
        gp_Trsf world;
        if (uint32_t plc = refOf(p->args[5])) world = placement(plc);

        // regroupement par style : cle sur les quatre canaux quantifies 8 bits
        std::map<uint32_t, std::vector<TopoDS_Shape>> groups;
        std::map<uint32_t, Mesh> mgroups;
        std::map<uint32_t, Style> gstyle;
        for (const Leaf& lf : leaves) {
            Style lst; bool lhas = styleOfLeaf(lf.item, lst);
            uint32_t lkey = lhas ? (((uint32_t)std::lround(lst.a * 255.0f) << 24)
                                  | ((uint32_t)std::lround(lst.r * 255.0f) << 16)
                                  | ((uint32_t)std::lround(lst.g * 255.0f) << 8)
                                  |  (uint32_t)std::lround(lst.b * 255.0f)) : 0xFFFFFFFFu;

            // D'ABORD le chemin maillage. Si l'item EST un jeu de faces, il part
            // tel quel : ni face OCCT, ni couture, ni mailleur. La table de
            // sommets est LOCALE a la feuille, parce que deux instances d'un
            // meme prototype citent les memes points a des places differentes.
            if (allowMesh) {
                Mesh mm;
                std::unordered_map<uint64_t,uint32_t> vmap;
                bool got = false;
                try { got = meshOfItem(lf.item, world * lf.trsf, mm, vmap); } catch (...) { got = false; }
                if (got && !mm.empty()) {
                    meshAppend(mgroups[lkey], mm);
                    if (lhas) gstyle[lkey] = lst;
                    continue;
                }
            }

            TopoDS_Shape sh;
            try { sh = item(lf.item, 1); } catch (...) { continue; }
            if (sh.IsNull()) continue;
            try {
                gp_Trsf t = world * lf.trsf;
                if (t.Form() != gp_Identity) sh = BRepBuilderAPI_Transform(sh, t, Standard_False).Shape();
            } catch (...) { continue; }
            Style st = lst; bool has = lhas;
            uint32_t key = has ? (((uint32_t)std::lround(st.a * 255.0f) << 24)
                                | ((uint32_t)std::lround(st.r * 255.0f) << 16)
                                | ((uint32_t)std::lround(st.g * 255.0f) << 8)
                                |  (uint32_t)std::lround(st.b * 255.0f)) : 0xFFFFFFFFu;
            groups[key].push_back(sh);
            if (has) gstyle[key] = st;
        }
        for (auto& kv : groups) {
            Piece pc;
            if (kv.second.size() == 1) pc.shape = kv.second[0];
            else {
                TopoDS_Compound c; BRep_Builder bb; bb.MakeCompound(c);
                for (auto& sh : kv.second) bb.Add(c, sh);
                pc.shape = c;
            }
            auto gi = gstyle.find(kv.first);
            if (gi != gstyle.end()) { pc.style = gi->second; pc.hasStyle = true; }
            out.push_back(pc);
        }
        for (auto& kv : mgroups) {
            if (kv.second.empty()) continue;
            Piece pc;
            pc.isMesh = true;
            pc.mesh = std::move(kv.second);
            auto gi = gstyle.find(kv.first);
            if (gi != gstyle.end()) { pc.style = gi->second; pc.hasStyle = true; }
            out.push_back(pc);
        }
    }

    bool hasBody(uint32_t pid) const {
        const Ent* p = get(pid);
        if (!p || p->args.size() < 7) return false;
        const Ent* pds = get(refOf(p->args[6]));
        if (!pds || pds->args.size() < 3) return false;
        for (uint32_t r : refsOf(pds->args[2])) {
            const Ent* re = get(r);
            if (re && re->args.size() > 1 && txtOf(re->args[1]) == "Body") return true;
        }
        return false;
    }

    // ── styles ───────────────────────────────────────────────────────────────
    void collectStyles() {
        for (const auto& kv : M) {
            const Ent& e = kv.second;
            if (e.type != "IFCSTYLEDITEM" || e.args.size() < 2) continue;
            uint32_t target = refOf(e.args[0]);
            if (!target) continue;
            Style st;
            std::vector<uint32_t> stack = refsOf(e.args[1]);
            std::set<uint32_t> seen;
            while (!stack.empty()) {
                uint32_t x = stack.back(); stack.pop_back();
                if (!seen.insert(x).second) continue;
                const Ent* se = get(x);
                if (!se) continue;
                if (se->type == "IFCSURFACESTYLERENDERING" && !se->args.empty()) {
                    const Ent* c = get(refOf(se->args[0]));
                    if (c && c->args.size() >= 4) {
                        std::vector<double> v;
                        for (int k = 1; k <= 3; k++) numsInto(c->args[k], v);
                        if (v.size() >= 3) { st.r=(float)v[0]; st.g=(float)v[1]; st.b=(float)v[2]; st.set = true; }
                    }
                    if (se->args.size() > 1) {
                        auto tr = numsOf(se->args[1]);
                        if (!tr.empty()) st.a = (float)(1.0 - tr[0]);
                    }
                } else if (se->type == "IFCCOLOURRGB" && se->args.size() >= 4 && !st.set) {
                    std::vector<double> v;
                    for (int k = 1; k <= 3; k++) numsInto(se->args[k], v);
                    if (v.size() >= 3) { st.r=(float)v[0]; st.g=(float)v[1]; st.b=(float)v[2]; st.set = true; }
                } else {
                    for (SV a : se->args) refsInto(a, stack);
                }
            }
            if (st.set) styleOf[target] = st;
        }
    }

    // Tous les items geometriques d une representation, MAPPED ITEMS DEPLIES.
    // Sans ce depliage, 253 meubles et 206 fenetres perdent leur couleur : le
    // style n est jamais sur l IfcMappedItem, toujours sur la source.
    void itemsOfRep(uint32_t rid, std::vector<uint32_t>& out, int depth = 0) const {
        const Ent* e = get(rid);
        if (!e || e->args.size() < 4 || depth > 8) return;
        for (uint32_t it : refsOf(e->args[3])) {
            const Ent* ie = get(it);
            if (!ie) continue;
            if (ie->type == "IFCMAPPEDITEM" && !ie->args.empty()) {
                const Ent* src = get(refOf(ie->args[0]));
                if (src && src->args.size() > 1) itemsOfRep(refOf(src->args[1]), out, depth + 1);
            } else out.push_back(it);
        }
    }

    bool colourOfProduct(uint32_t pid, Style& out) const {
        const Ent* p = get(pid);
        if (!p || p->args.size() < 7) return false;
        const Ent* pds = get(refOf(p->args[6]));
        if (!pds || pds->args.size() < 3) return false;
        for (uint32_t r : refsOf(pds->args[2])) {
            const Ent* re = get(r);
            if (!re || re->args.size() < 2 || txtOf(re->args[1]) != "Body") continue;
            std::vector<uint32_t> items;
            itemsOfRep(r, items);
            for (uint32_t it : items) {
                auto s1 = styleOf.find(it);
                if (s1 != styleOf.end()) { out = s1->second; return true; }
                const Ent* ie = get(it);
                if (ie && ie->type == "IFCFACETEDBREP" && !ie->args.empty()) {
                    const Ent* sh = get(refOf(ie->args[0]));
                    if (sh && !sh->args.empty())
                        for (uint32_t f : refsOf(sh->args[0])) {
                            auto s2 = styleOf.find(f);
                            if (s2 != styleOf.end()) { out = s2->second; return true; }
                        }
                }
            }
        }
        return false;
    }
};

} // namespace nasifc

// [FIX 27/09] Cf. sa declaration, avant extractIntoTopo : le remplissage des
// faces sans triangulation reutilise la decoupe d'oreilles du lecteur IFC.
//
// MODE FORCE. Le contour d'une face que BRepMesh a ratee est souvent celui qui
// l'a fait echouer : KR600, corps 0, un « trou » en croissant de 0,5 micron de
// large, borde par deux arcs quasi confondus discretises independamment par
// leurs faces voisines — les deux polylignes se CROISENT. Aucun trianguleur
// geometrique strict ne triangule un contour auto-intersectant ; c'est ce qui a
// fait echouer BRepMesh, et c'est ce qui ferait echouer le strict ici.
// forced=true garantit un resultat : pont le plus court meme s'il croise, et a
// defaut d'oreille valide, l'oreille convexe qui contient le moins de points
// (a defaut, la moins concave). Chaque oreille suit l'ordre cyclique du
// contour : chaque segment de bord est pris par exactement UN triangle, dans
// le sens oppose a sa voisine — la variete est fermee et orientee quelle que
// soit la geometrie. Le recouvrement eventuel reste confine a la zone qui se
// croisait deja, de l'ordre de la largeur du croissant.
static bool fillTriangulate2D(const std::vector<std::pair<double, double>>& pts,
                              std::vector<uint32_t> outer,
                              std::vector<std::vector<uint32_t>> holes,
                              std::vector<uint32_t>& tris,
                              bool forced,
                              const std::vector<uint32_t>* ident) {
    using nasifc::tri::P2;
    using nasifc::tri::cross2;
    std::vector<P2> P(pts.size());
    for (size_t k = 0; k < pts.size(); ++k) P[k] = P2{ pts[k].first, pts[k].second };
    auto loopArea = [&](const std::vector<uint32_t>& l) {
        double s = 0;
        for (size_t i = 0; i < l.size(); ++i) {
            const P2& a = P[l[i]]; const P2& b = P[l[(i + 1) % l.size()]];
            s += a.x * b.y - b.x * a.y;
        }
        return 0.5 * s;
    };
    if (!holes.empty() && !nasifc::tri::bridgeHoles(P, outer, holes)) {
        if (!forced) return false;
        // Pont le plus court, croisement tolere, un trou apres l'autre.
        for (auto& hole : holes) {
            if (hole.size() < 3) continue;
            if ((loopArea(hole) > 0) == (loopArea(outer) > 0)) std::reverse(hole.begin(), hole.end());
            double best = 1e300; size_t bi = 0, bj = 0;
            for (size_t i = 0; i < outer.size(); ++i)
                for (size_t j = 0; j < hole.size(); ++j) {
                    const P2& A = P[outer[i]]; const P2& B = P[hole[j]];
                    const double d = (A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y);
                    if (d < best) { best = d; bi = i; bj = j; }
                }
            std::vector<uint32_t> merged;
            merged.reserve(outer.size() + hole.size() + 2);
            for (size_t i = 0; i <= bi; ++i) merged.push_back(outer[i]);
            for (size_t j = 0; j < hole.size(); ++j) merged.push_back(hole[(bj + j) % hole.size()]);
            merged.push_back(hole[bj]);
            for (size_t i = bi; i < outer.size(); ++i) merged.push_back(outer[i]);
            outer.swap(merged);
        }
    }
    std::vector<P2> q;
    q.reserve(outer.size());
    for (uint32_t k : outer) q.push_back(P[k]);
    std::vector<uint32_t> t;
    // En mode force on ne refait pas d'abord la decoupe stricte (O(n^3)) : la
    // boucle ci-dessous prend deja une oreille valide des qu'il en existe une.
    if (forced || !nasifc::tri::earClip(q, t)) {
        if (!forced || q.size() < 3) return false;
        t.clear();
        std::vector<uint32_t> v(q.size());
        for (size_t i = 0; i < q.size(); ++i) v[i] = (uint32_t)i;
        if (nasifc::tri::area2(q) < 0) std::reverse(v.begin(), v.end());
        auto same = [](const P2& a, const P2& b) { return std::fabs(a.x - b.x) < 1e-12 && std::fabs(a.y - b.y) < 1e-12; };
        // Une diagonale ne doit jamais redoubler une arete deja la : le pontage
        // fait passer le contour plusieurs fois par les memes sommets, et une
        // « nouvelle » diagonale entre deux de leurs occurrences peut etre une
        // arete du contour — elle finirait a trois triangles. On raisonne sur
        // l'identite des noeuds (`ident`), pas sur les positions.
        auto idOf = [&](uint32_t qi) -> uint32_t { const uint32_t k = outer[qi]; return ident ? (*ident)[k] : k; };
        auto ekey = [](uint32_t a, uint32_t b) -> uint64_t {
            if (a > b) std::swap(a, b);
            return ((uint64_t)a << 32) | b;
        };
        std::unordered_set<uint64_t> have;
        for (size_t i = 0; i < q.size(); ++i) have.insert(ekey(idOf((uint32_t)i), idOf((uint32_t)((i + 1) % q.size()))));
        auto clash = [&](size_t ip, size_t in) {
            const uint32_t x = idOf(v[ip]), y = idOf(v[in]);
            return x == y || have.count(ekey(x, y)) != 0;
        };
        while (v.size() > 3) {
            size_t pick = SIZE_MAX, bestIn = SIZE_MAX;
            double bestCr = -1e300;
            for (size_t i = 0; i < v.size(); ++i) {
                const size_t ip = (i + v.size() - 1) % v.size(), in = (i + 1) % v.size();
                const P2& a = q[v[ip]]; const P2& b = q[v[i]]; const P2& c = q[v[in]];
                const double cr = cross2(a, b, c);
                if (cr <= 0 || clash(ip, in)) continue;
                size_t inside = 0;
                for (size_t k = 0; k < v.size(); ++k) {
                    if (k == ip || k == i || k == in) continue;
                    const P2& p = q[v[k]];
                    if (same(p, a) || same(p, b) || same(p, c)) continue;
                    if (nasifc::tri::inTri(a, b, c, p)) inside++;
                }
                if (inside < bestIn || (inside == bestIn && cr > bestCr)) { bestIn = inside; bestCr = cr; pick = i; }
                if (inside == 0) break;
            }
            // Aucun sommet convexe sans redoublement : le moins concave qui ne
            // redouble rien, et seulement a defaut, le moins concave tout court.
            for (int pass = 0; pass < 2 && pick == SIZE_MAX; ++pass)
                for (size_t i = 0; i < v.size(); ++i) {
                    const size_t ip = (i + v.size() - 1) % v.size(), in = (i + 1) % v.size();
                    if (pass == 0 && clash(ip, in)) continue;
                    const double cr = cross2(q[v[ip]], q[v[i]], q[v[in]]);
                    if (pick == SIZE_MAX || cr > bestCr) { bestCr = cr; pick = i; }
                }
            const size_t ip = (pick + v.size() - 1) % v.size(), in = (pick + 1) % v.size();
            have.insert(ekey(idOf(v[ip]), idOf(v[in])));
            t.push_back(v[ip]); t.push_back(v[pick]); t.push_back(v[in]);
            v.erase(v.begin() + (std::ptrdiff_t)pick);
        }
        t.push_back(v[0]); t.push_back(v[1]); t.push_back(v[2]);
    }
    tris.clear();
    tris.reserve(t.size());
    for (uint32_t k : t) tris.push_back(outer[k]);
    return true;
}










// ═════════════════════════════════════════════════════════════════════════════
// [24/09 — Nass : « il est encore trop lourd ! » — AP203 : 357 Mo -> 1,18 Go]
// CACHE DES B-REP D'IMPORT — MEDUSA garde la geometrie EXACTE de ce qu'il lit.
//
// Un maillage en AP203/AP214 ne peut pas descendre sous ~3 entites par
// triangle (FACETED_BREP) : le fichier d'origine, lui, decrit ses pieces en
// surfaces exactes (plans, cylindres, B-splines) et ne les ecrit qu'UNE fois
// par prototype (180 produits / 726 occurrences sur le Scania V8). La seule
// facon de revenir a sa taille — et a sa precision — est de reecrire ce B-Rep
// d'origine, instances comprises, pour chaque corps que l'utilisateur n'a pas
// modifie. C'est ce que fait toute CAO : elle exporte son modele, pas son
// affichage.
//
// Ici : chaque import garde ses corps (TopoDS_Shape places dans le repere du
// fichier, en mm, avec leurs couleurs d'origine) sous une ETIQUETTE, et chaque
// maillage envoye au client porte sa reference « <etiquette>:<rang>:<signature> ».
//
// [24/09, soir] L'etiquette est le CONTENU du fichier : « h » + les 32 premiers
// chiffres hexa du SHA-256 que le client calcule deja pour ses caches
// (?tag= sur /stepstream et /stepload). Pourquoi : un fichier deja importe
// ressort du cache du navigateur (NSPG/NSTP) SANS passer par MEDUSA, et MEDUSA
// peut avoir redemarre entre l'import et l'export. Une etiquette de session
// rendait alors l'export exact impossible — exactement sur les gros fichiers
// qu'on reimporte, c'est-a-dire la ou il compte. Avec une etiquette de
// contenu, la reference survit : si MEDUSA ne tient plus ce fichier, le client
// le lui renvoie (POST /stepload, lecture SANS maillage) et les memes rangs
// retrouvent les memes pieces. Sans ?tag= (vieux client), l'etiquette reste
// « <nonce de session>-<numero> », comme avant.
//
// Rien ne suppose que deux lectures donnent les memes rangs : chaque reference
// porte la SIGNATURE de sa piece (exactSig : topologie + boite des sommets), et
// une reference dont la signature ne correspond plus n'est pas trouvee. Un
// changement du code de lecture entre l'import et l'export, un cache client
// d'une autre version : le corps repart en maillage — jamais un mauvais corps.
// Retention : les kMaxImports derniers imports, moins si la RAM libre passe
// sous kMinFreeMB (le plus ancien part d'abord) ; une nouvelle lecture du meme
// fichier REMPLACE la precedente. Les triangulations sont retirees des formes
// gardees (BRepTools::Clean) : le client a deja son maillage, seul le B-Rep
// sert a l'export.
// ═════════════════════════════════════════════════════════════════════════════
struct ExactPart {
    TopoDS_Shape part;                          // B-Rep exact, place (repere fichier, mm)
    std::shared_ptr<FaceColorMap> faceColors;   // couleurs de faces d'origine (nul = unie)
    bool hasColor = false; float r = 0, g = 0, b = 0, a = 1.0f;   // couleur d'origine du corps
    uint32_t sig = 0;                           // exactSig(part), cf. exactRef/findImport
};
struct ImportEntry {
    std::string tag;
    std::vector<ExactPart> parts;
    // [24/09] Un mesheur detache a survecu a cet import : il ecrit peut-etre
    // encore dans des faces partagees avec ces formes. Plus personne n'y touche,
    // donc pas de BRepTools::Clean (qui retire les triangulations) : de la
    // memoire en plus, contre un acces concurrent qui tue le process.
    bool keepTriangulation = false;
};
static long readAvailableRamMB();
static std::mutex gImportMx;
static std::deque<std::shared_ptr<const ImportEntry>> gImports;
static std::atomic<uint64_t> gImportSeq{0};
static constexpr size_t kMaxImports = 12;
static constexpr long kMinFreeMB = 1536;
static const std::string& sessionNonce() {
    static const std::string nonce = [] {
        std::random_device rd;
        const uint64_t v = ((uint64_t)rd() << 32) ^ (uint64_t)rd()
                         ^ (uint64_t)std::chrono::steady_clock::now().time_since_epoch().count();
        char b[20]; std::snprintf(b, sizeof b, "%016llx", (unsigned long long)v);
        return std::string(b);
    }();
    return nonce;
}
static std::string newImportTag() { return sessionNonce() + "-" + std::to_string(gImportSeq.fetch_add(1) + 1); }
// Valeur d'un parametre de requete (cles comparees entieres, cf. parseQueryTuning).
static std::string queryValue(const std::string& path, const std::string& key) {
    const auto qpos = path.find('?');
    if (qpos == std::string::npos) return std::string();
    const std::string q = path.substr(qpos + 1);
    size_t pos = 0;
    while (pos < q.size()) {
        const size_t amp = q.find('&', pos);
        const std::string kv = q.substr(pos, (amp == std::string::npos) ? std::string::npos : amp - pos);
        pos = (amp == std::string::npos) ? q.size() : amp + 1;
        const size_t eq = kv.find('=');
        if (eq != std::string::npos && kv.compare(0, eq, key) == 0) return kv.substr(eq + 1);
    }
    return std::string();
}
// ?tag=<empreinte hexa du fichier> -> « h » + 32 chiffres hexa minuscules, ou
// vide si absent ou mal forme (l'import prend alors une etiquette de session).
static std::string fileTagFromQuery(const std::string& path) {
    std::string v = queryValue(path, "tag");
    if (v.size() < 16) return std::string();
    if (v.size() > 32) v.resize(32);
    for (char& c : v) {
        if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return std::string();
    }
    return "h" + v;
}
// Signature d'une piece : nombres de faces, d'aretes et de sommets, et boite
// englobante de ses SOMMETS au micron (repere fichier, placement compris).
// Deux lectures du meme fichier par le meme code la redonnent au bit pres ;
// une autre piece, un autre rang ou un autre placement, non. Les sommets, et
// non la boite des surfaces : c'est de la donnee lue, pas un calcul — rien ne
// depend de la presence d'une triangulation ni d'une tolerance.
static uint32_t exactSig(const TopoDS_Shape& s) {
    TopTools_IndexedMapOfShape mf, me, mv;
    TopExp::MapShapes(s, TopAbs_FACE, mf);
    TopExp::MapShapes(s, TopAbs_EDGE, me);
    TopExp::MapShapes(s, TopAbs_VERTEX, mv);
    uint64_t h = 1469598103934665603ULL;                        // FNV-1a 64
    auto mix = [&h](long long v) {
        for (int b = 0; b < 8; b++) { h ^= (uint64_t)((unsigned long long)v >> (8 * b)) & 0xffu; h *= 1099511628211ULL; }
    };
    mix(mf.Extent()); mix(me.Extent()); mix(mv.Extent());
    if (mv.Extent() > 0) {
        double lo[3] = { 1e300, 1e300, 1e300 }, hi[3] = { -1e300, -1e300, -1e300 };
        for (int i = 1; i <= mv.Extent(); i++) {
            const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(mv(i)));
            const double c[3] = { p.X(), p.Y(), p.Z() };
            for (int k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
        }
        for (int k = 0; k < 3; k++) { mix(std::llround(lo[k] * 1000.0)); mix(std::llround(hi[k] * 1000.0)); }
    }
    return (uint32_t)(h ^ (h >> 32));
}
static void signParts(ImportEntry& e, size_t from) {
    parallelForIndices(e.parts.size() - from, 0, [&](size_t i) {
        ExactPart& p = e.parts[from + i];
        if (!p.part.IsNull()) p.sig = exactSig(p.part);
    });
}
static std::string exactRef(const ImportEntry& e, size_t i) {
    char b[12]; std::snprintf(b, sizeof b, "%08x", (unsigned)e.parts[i].sig);
    return e.tag + ":" + std::to_string(i) + ":" + b;
}
static void rememberImport(std::shared_ptr<ImportEntry> e) {
    if (!e->keepTriangulation)
        for (auto& p : e->parts) if (!p.part.IsNull()) BRepTools::Clean(p.part);
    std::lock_guard<std::mutex> lk(gImportMx);
    for (auto it = gImports.begin(); it != gImports.end();)
        it = ((*it)->tag == e->tag) ? gImports.erase(it) : std::next(it);
    gImports.push_back(std::move(e));
    while (gImports.size() > kMaxImports) gImports.pop_front();
    while (gImports.size() > 1 && readAvailableRamMB() > 0 && readAvailableRamMB() < kMinFreeMB) gImports.pop_front();
}
static std::vector<std::string> heldImportTags() {
    std::lock_guard<std::mutex> lk(gImportMx);
    std::vector<std::string> v;
    for (auto& e : gImports) v.push_back(e->tag);
    return v;
}
// Rend l'import d'une reference « tag:rang:signature » et le rang, ou nullptr :
// perimee, evincee, autre session, ou signature differente (la piece a ce rang
// n'est plus celle que le client a recue). L'entree reste vivante tant que
// l'appelant garde le shared_ptr, meme si elle est evincee entre-temps.
static std::shared_ptr<const ImportEntry> findImport(const std::string& ref, size_t& index) {
    const size_t c1 = ref.find(':');
    const size_t c2 = (c1 == std::string::npos) ? std::string::npos : ref.find(':', c1 + 1);
    if (c1 == std::string::npos || c2 == std::string::npos || c2 == c1 + 1 || ref.size() != c2 + 9) return nullptr;
    unsigned long long k = 0;
    for (size_t i = c1 + 1; i < c2; i++) {
        if (ref[i] < '0' || ref[i] > '9' || k > 100000000ULL) return nullptr;
        k = k * 10 + (unsigned long long)(ref[i] - '0');
    }
    uint32_t sig = 0;
    for (size_t i = c2 + 1; i < ref.size(); i++) {
        const char c = ref[i];
        const int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1;
        if (d < 0) return nullptr;
        sig = (sig << 4) | (uint32_t)d;
    }
    const std::string tag = ref.substr(0, c1);
    std::lock_guard<std::mutex> lk(gImportMx);
    for (auto& e : gImports)
        if (e->tag == tag && k < e->parts.size() && !e->parts[k].part.IsNull() && e->parts[k].sig == sig) {
            index = (size_t)k; return e;
        }
    return nullptr;
}

// fileTag : etiquette de l'import dans le cache des B-Rep (cf. fileTagFromQuery),
// vide = etiquette de session. exactOnly : /stepload — lire et garder les formes
// exactes, sans reparation ni maillage ; rien n'est rendu.
static std::vector<uint8_t> processStepBuffer(const std::string& body, double deflectionOverride,
                                               double& outTessMs, int& outFaceCount,
                                               std::function<void(const MeshData&)> sink = nullptr,
                                               const std::string& fileTag = std::string(),
                                               bool exactOnly = false) {
    auto t0 = Clock::now();
    // [17/09] Chronos PAR PHASE. Le balayage du 17/09 a montre que la
    // tessellation — la seule chose que la deflexion pilote — pese 11 a 21 s sur
    // un import de 138 a 212 s, et que tout le reste est avant elle. On ne
    // pouvait pas le savoir : le log ne donnait qu'un total. Trois chronos
    // suffisent a ne plus jamais optimiser le mauvais tiers.
    auto tPhase = Clock::now();
    double msParse = 0, msResolve = 0, msTess = 0;

    // deflectionOverride > 0 = valeur EXPLICITE (?deflection= dans l'URL) : prioritaire
    // sur le ratio bbox — pour les tests comparatifs (ex: hypothese deflection vs
    // non-manifold). Sentinel <= 0 = mode auto (ratio bbox occt-import-js, defaut).
    gDeflectionOverride = deflectionOverride;
    // Metadonnees header (zone HEADER seulement, max 8KB — jamais la zone DATA)
    std::string head = body.substr(0, std::min<size_t>(body.size(), 8192));
    std::string metaName      = headerField(head, "FILE_NAME", 0);
    std::string metaTimestamp = headerField(head, "FILE_NAME", 1);
    std::string metaAuthor    = headerField(head, "FILE_NAME", 2);
    std::string metaOrg       = headerField(head, "FILE_NAME", 3);
    std::string metaSystem    = headerField(head, "FILE_NAME", 5);
    std::string metaSchema    = headerField(head, "FILE_SCHEMA", 0);

    std::istringstream stream(body, std::ios::binary);

    Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    // [FIX memoire] XCAFApp_Application::GetApplication() renvoie TOUJOURS la
    // meme instance (singleton process-wide) — et NewDocument() enregistre
    // chaque document cree dans la liste INTERNE de cette instance, qui n'est
    // jamais videe tant qu'on n'appelle pas explicitement Close(doc). Le
    // Handle local `doc` sortant de portee en fin de fonction ne libere donc
    // RIEN : le document (geometrie + couleurs + noms XCAF complets) reste
    // vivant pour le reste de la vie du process. Chaque requete /step ou
    // /stepstream (des dizaines par seconde possibles, cf. medusa.log) en
    // laissait fuiter un -> explosion memoire progressive jusqu'a l'OOM.
    // RAII : ferme automatiquement sur CHAQUE sortie de la fonction, retour
    // normal comme exception (ex: les throw "STEP parsing failed" /
    // "STEP: no shape transferred" / "STEP: no tessellable geometry found"
    // plus bas) — pas besoin de dupliquer l'appel a chaque point de sortie.
    struct DocGuard {
        Handle(XCAFApp_Application) app;
        Handle(TDocStd_Document) doc;
        ~DocGuard() { if (!doc.IsNull()) app->Close(doc); }
    } docGuard{app, doc};

    // [24/09] Corps exacts de cet import, cf. ImportEntry. Enregistres a la fin,
    // seulement si l'import a produit quelque chose.
    auto impEntry = std::make_shared<ImportEntry>();
    impEntry->tag = fileTag.empty() ? newImportTag() : fileTag;
    // [24/09, soir] Fin de /stepload : les formes exactes, signees, gardees sous
    // l'etiquette du fichier. Ni reparation, ni maillage, ni flux — la moitie la
    // plus chere d'un import, dont le client n'a pas besoin : il a deja son
    // maillage. Les rangs sont ceux de l'import, puisque c'est le meme code qui
    // enumere les pieces jusqu'ici.
    auto finishExactOnly = [&]() -> std::vector<uint8_t> {
        if (impEntry->parts.empty()) throw std::runtime_error("STEP: no shape transferred");
        rememberImport(impEntry);
        gColorTool.Nullify();
        gShapeTool.Nullify();
        outTessMs = ms(t0, Clock::now());
        return {};
    };

    STEPCAFControl_Reader caf;
    caf.SetNameMode(Standard_True);
    caf.SetColorMode(Standard_True);
    caf.SetLayerMode(Standard_False);
    caf.SetGDTMode(Standard_False);

    IFSelect_ReturnStatus stat = caf.ChangeReader().ReadStream("medusa_input.step", stream);
    std::vector<MeshData> meshes;
    outFaceCount = 0;

    bool cafOk = false;
    if (stat == IFSelect_RetDone) {
        Handle(ConsoleProgress) parseProgress = new ConsoleProgress();
        cafOk = caf.Transfer(doc, parseProgress->Start()) != Standard_False;
        msParse = ms(tPhase, Clock::now()); tPhase = Clock::now();
    }

    if (cafOk) {
        Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
        Handle(XCAFDoc_ColorTool) colorTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
        gColorTool = colorTool; // publie pour la resolution couleur par solide (voir boucle)
        gShapeTool = shapeTool; // idem, pour FindSubShape (resolution par label, pas par hash)
        gFaceScanCache.clear(); // [31/08] cache de balayage par prototype — un document XCAF par import
        gRepairedCount = 0;
        gAbandonedCount = 0;     // [16/09] corps non maillables, cf. tessellateShape
        tessMemoReset();         // [FIX 17/09 soir] memoire par TShape, valable un import
        gPartialRepairCount = 0; // [15/08 FIX v5]
        gManifoldIssueCount = 0; // [15/08 FIX v5]
        // [21/09] Compteurs de la couture par topologie — meme duree de vie
        // qu'une requete, publies ensuite dans gMetaJson.
        gWeldBodies = 0; gWeldWatertight = 0; gWeldFallback = 0;
        gWeldEdgesTopo = 0; gWeldEdgesResidual = 0; gWeldEdgesMismatch = 0;
        gWeldTrisDropped = 0;
        gWeldFacesFilled = 0; gWeldDiagFlips = 0;   // [FIX 27/09]
        TDF_LabelSequence freeShapes;
        shapeTool->GetFreeShapes(freeShapes);

        std::vector<LeafShape> leaves;
        for (Standard_Integer i = 1; i <= freeShapes.Length(); i++) {
            // Déflection bbox-ratio de la racine — identique occt-import-js.
            TopoDS_Shape rootShape = XCAFDoc_ShapeTool::GetShape(freeShapes.Value(i));
            if (!rootShape.IsNull()) gRootDeflection = rootDeflectionLikeOcctImportJs(rootShape);
            collectLeaves(shapeTool, colorTool, freeShapes.Value(i), TopLoc_Location(), leaves, 0);
        }


        // Éclatement par solide individuel : une étiquette XCAF nommée peut contenir
        // plusieurs solides disjoints (ex: un PCB avec composants = 14 solides sous UN
        // seul nom) — occt-import-js les compte comme autant de mesh séparés. Validé
        // empiriquement : total solides == total mesh(es) rapporté par NASSCAD (198/198).
        //
        // Progression en direct : sur un gros assemblage (Scania 1449 corps, plusieurs
        // minutes), rester muet jusqu'au resultat final ressemble a un blocage — meme
        // s'il n'y en a pas. Une ligne qui s'auto-met a jour (retour chariot \r, pas de
        // saut de ligne) confirme visuellement que ca avance, sans polluer le terminal
        // de milliers de lignes.
        // [15/08] PHASE A (séquentielle) — explosion en solides/shells + résolution
        // couleur/nom : tout ce qui lit gColorTool/gShapeTool (document XCAF
        // partagé, non prouvé thread-safe en lecture concurrente) reste ICI, sur
        // le thread principal, EXACTEMENT comme avant. Le seul changement : au
        // lieu de tesselliser/extraire immédiatement, chaque pièce résolue devient
        // un "PartJob" autonome (shape déjà positionnée + couleur déjà résolue +
        // déflection déjà choisie) empilé dans `jobs` — plus aucun de ces jobs ne
        // touchera le document XCAF ensuite, ce qui rend la PHASE B (plus bas)
        // parallélisable sans risque sur le document.
        struct PartJob {
            TopoDS_Shape part;
            std::string name;
            std::optional<Quantity_Color> color;
            // [17/09] `deflection` a disparu d'ici : elle etait calculee dans la
            // boucle SEQUENTIELLE (phase A), qui pese 87 % de l'import mesure, et
            // demandait un parcours topologique complet par corps. Elle est
            // desormais calculee dans la phase parallele, ou elle coute six fois
            // moins cher de temps mur. Seul le plafond, qui vient de la racine et
            // non du corps, reste connu ici.
            double deflectionCap; // deflection de sa racine = plafond, jamais depasse
            std::shared_ptr<FaceColorMap> faceColors; // [27/08] cf. LeafShape
            float alpha = 1.0f;   // [18/09] opacite du corps, cf. LeafShape::alpha
        };
        std::vector<PartJob> jobs;
        jobs.reserve(leaves.size());

        // [15/08 FIX v4] Phase A a de nouveau sa barre ("RESOLUTION"), demandee
        // explicitement par Nass ("pareil pour color... tu comprends??"). Le
        // premier essai (FIX v1) avait echoue car [COLOR] restait imprime EN
        // CLAIR sur la console entre deux frames de barre — chaque ligne
        // [COLOR] fermait la frame precedente (comportement normal et voulu,
        // cf. TeeStreambuf::flushBuffer) puis la barre suivante repartait sur
        // une NOUVELLE ligne -> defilement, pas d'ecrasement sur place.
        // Cette fois, [COLOR] part en FICHIER UNIQUEMENT (logFileOnly, cf. sa
        // definition) — plus aucun texte ne s'intercale sur la console entre
        // deux frames RESOLUTION, qui peuvent donc s'ecraser proprement sur
        // place, exactement comme PARSING/TESSELLATION. Rien n'est perdu :
        // medusa.log recoit toujours le detail complet, [COLOR] y compris.
        barPhaseStart();
        size_t resolveLeafIdx = 0;
        for (const auto& leaf : leaves) {
            std::vector<TopoDS_Shape> parts, rawParts;
            {
                // Enumeration a la occt-import-js : solides, PUIS shells hors solides
                // (TopAbs_SHELL avec avoid TopAbs_SOLID) — une piece mixte (1 solide +
                // 1 shell libre) sort en 2 meshes chez le kador, idem ici desormais.
                // Moved() ne change pas l'ordre topologique : explorations paralleles sures.
                TopExp_Explorer sp(leaf.shape, TopAbs_SOLID), sr(leaf.rawShape, TopAbs_SOLID);
                for (; sp.More() && sr.More(); sp.Next(), sr.Next()) {
                    parts.push_back(sp.Current()); rawParts.push_back(sr.Current());
                }
                TopExp_Explorer hp(leaf.shape, TopAbs_SHELL, TopAbs_SOLID),
                                hr(leaf.rawShape, TopAbs_SHELL, TopAbs_SOLID);
                for (; hp.More() && hr.More(); hp.Next(), hr.Next()) {
                    parts.push_back(hp.Current()); rawParts.push_back(hr.Current());
                }
            }
            if (parts.empty()) { parts.push_back(leaf.shape); rawParts.push_back(leaf.rawShape); }

            for (size_t pi = 0; pi < parts.size(); pi++) {
                const auto& part = parts[pi];
                const auto& rawPart = rawParts[pi];
                // Couleur : priorite au SOLIDE individuel (cas multi-solides type PCB :
                // chaque composant electronique porte SA couleur, le label parent n'en a
                // aucune — verifie empiriquement : 12 pieces / 92 solides concernes sur
                // le Stealthburner, 100% des couleurs retrouvees a ce niveau). Fallback :
                // couleur du label parent (cas classique mono-solide), puis premiere face
                // coloree (filet, jamais vu necessaire sur les fichiers testes).
                //
                // [13/08] partColPath ajoute — diagnostic suite a une divergence visuelle
                // NASSCAD vs Fusion/FreeCAD sur Scania-Engine-V8-XT-Turbo (meme fichier,
                // export Fusion) : seulement 12/1297 pieces resolues en teinte orange,
                // 620/1297 en gris-bleu fonce, alors que Fusion/FreeCAD affichent une
                // masse orange dominante. Hypothese non tranchee : la priorite
                // solide-avant-label (correcte sur Stealthburner) pourrait attraper une
                // couleur materiau generique au niveau du solide qui masque la VRAIE
                // teinte cosmetique posee au niveau assemblage/label sur CE fichier
                // precis. Ce marqueur permet de le confirmer ou l'infirmer avec le
                // prochain log, plutot que de deviner une nouvelle fois.
                // [13/08 — neuro-chir] partColPath : diagnostic complet du 13/08 a montre
                // 100% des resolutions (bonnes ET mauvaises) passant par tierB-solid-Surf —
                // pas un probleme de PRIORITE entre etages, mais GetColor(TopoDS_Shape)
                // lui-meme qui retourne parfois la mauvaise couleur au niveau sous-solide.
                // Mecanisme : GetColor hash l'identite exacte de la forme : rien ne garantit
                // qu'un sous-solide extrait via TopExp_Explorer(leaf.rawShape) corresponde
                // hash-pour-hash a ce que le ColorTool a enregistre en interne — meme classe
                // de fragilite documentee (recherche du 13/08 : GetColor casse depuis 7.4.0 ;
                // CollectStyleSettings, l'alternative "officielle", a son propre bug connu sur
                // les assemblages a instances repetees). resolvedLabel avait deja contourne ce
                // probleme au niveau du LEAF entier (198/198 vs 106/198) ; meme logique
                // appliquee ici au niveau SOUS-solide : FindSubShape donne un LABEL explicite
                // pour ce sous-solide precis, GetColor(label) evite alors le hash de forme —
                // tente EN PREMIER, avant le hash direct qui reste en repli (rien retire).
                // [27/08] PRIORITE INVERSEE — la couleur du LEAF gagne quand elle existe.
                //
                // Preuve (Scania-Engine-V8-XT-Turbo, 1170 pieces) : --decode-colors, qui
                // resout au niveau leaf, ne rend le jaune #DDDD0D que 4 fois sur tout le
                // fichier. L'import, lui, l'appliquait 565 fois. Deux pieces nommees le
                // montrent sans ambiguite :
                //     "Oil Pump V8-XT-11"  leaf = #BEBCBA (gris)  -> import = #DDDD0D
                //     "Engine V8-XT-11"    leaf = #5A6266 (gris)  -> import = #DDDD0D
                // Les deux etages d'ecrasement (FindSubShape par label, puis GetColor par
                // hash de forme) rendaient donc une couleur qui n'appartient pas a ce
                // sous-solide. FreeCAD et Fusion affichent le gris : c'est le leaf qui a
                // raison.
                //
                // Ces deux etages restent indispensables, mais UNIQUEMENT quand le leaf n'a
                // aucune couleur — c'est exactement le cas PCB du Stealthburner valide le
                // 13/08 ("chaque composant porte SA couleur, le label parent n'en a
                // aucune"). Ce cas passe toujours par le sous-solide, sans regression.
                //
                // ══ [31/08] La regle est bonne, l'explication ne l'etait pas. ═══════
                //
                // Le 27/08 attribuait le jaune a un ecrasement fautif : "les deux etages
                // rendaient une couleur qui n'appartient pas a ce sous-solide". Le log du
                // 31/08 montre le contraire — cf. la correction detaillee au-dessus de
                // gShapeTool. #DDDD0D appartient bel et bien a ce solide : c'est la
                // couleur que le fichier pose sur son MANIFOLD_SOLID_BREP. Ce qui ne lui
                // appartenait pas, c'etait la PRIORITE : les faces de ce meme solide
                // portent leur propre couleur, et la regle OCCT veut qu'elle gagne.
                //
                // "Le leaf gagne" tombait donc juste pour la mauvaise raison. Depuis le
                // 31/08 la raison est la bonne : leaf.color est desormais resolu par
                // decideBodyColor(), qui applique explicitement la precedence face >
                // solide. Cette garde continue de faire exactement ce qu'il faut — ne pas
                // la retirer — mais elle n'est plus un pansement sur un bug suppose
                // d'OCCT : elle propage une couleur de leaf deja correcte.
                //
                // Chiffres du meme log : 1255 corps sur 1295 passent par tierA-leaf, 40
                // par subshape-label-Surf (leaf sans couleur, le cas PCB). Le jaune tombe
                // de 53 prototypes a 2 corps.
                // ═══════════════════════════════════════════════════════════════════
                std::optional<Quantity_Color> partCol = leaf.color;
                const char* partColPath = leaf.color ? "tierA-leaf" : "tierB-none";
                Quantity_Color qc;
                TDF_Label subLabel;
                if (!partCol && gShapeTool && gShapeTool->FindSubShape(leaf.resolvedLabel, rawPart, subLabel)) {
                    if (gColorTool && gColorTool->GetColor(subLabel, XCAFDoc_ColorSurf, qc)) {
                        partCol = qc; partColPath = "subshape-label-Surf";
                    } else if (gColorTool && gColorTool->GetColor(subLabel, XCAFDoc_ColorGen, qc)) {
                        partCol = qc; partColPath = "subshape-label-Gen";
                    } else if (gColorTool && gColorTool->GetColor(subLabel, XCAFDoc_ColorCurv, qc)) {
                        partCol = qc; partColPath = "subshape-label-Curv";
                    }
                }
                // [27/08] Meme garde : ce repli par hash de forme (le plus fragile des
                // trois, cf. la recherche du 13/08) ne doit jamais ecraser une couleur de
                // leaf existante. Il ne sert plus que de dernier recours.
                if (!partCol) {
                if (gColorTool && gColorTool->GetColor(rawPart, XCAFDoc_ColorSurf, qc)) {
                    partCol = qc; partColPath = "tierB-solid-Surf";
                } else if (gColorTool && gColorTool->GetColor(rawPart, XCAFDoc_ColorGen, qc)) {
                    partCol = qc; partColPath = "tierB-solid-Gen";
                } else if (gColorTool && gColorTool->GetColor(rawPart, XCAFDoc_ColorCurv, qc)) {
                    partCol = qc; partColPath = "tierB-solid-Curv";
                } else if (!partCol && gColorTool) {
                    for (TopExp_Explorer fe(rawPart, TopAbs_FACE); fe.More(); fe.Next()) {
                        if (gColorTool->GetColor(fe.Current(), XCAFDoc_ColorSurf, qc)) { partCol = qc; partColPath = "tierB-face-Surf"; break; }
                        if (gColorTool->GetColor(fe.Current(), XCAFDoc_ColorGen, qc)) { partCol = qc; partColPath = "tierB-face-Gen"; break; }
                        if (gColorTool->GetColor(fe.Current(), XCAFDoc_ColorCurv, qc)) { partCol = qc; partColPath = "tierB-face-Curv"; break; }
                    }
                }
                } // ferme le bloc "if (!partCol)" ouvert plus haut [27/08]
                // [10/08] Log couleur COMPLET — chaque piece, pas seulement les
                // echecs (demande explicite : donnees d'analyse, pas juste alerte).
                // Va dans medusa.log via le Tee — permanent, relisible apres coup.
                // [15/08 FIX v4] logFileOnly plutot que cerr direct — voir le
                // commentaire au-dessus de la boucle (barre RESOLUTION). Reste
                // NON verrouille par gConsoleMutex : phase A est mono-thread par
                // construction (aucun worker demarre avant la fin de cette
                // boucle), donc pas de concurrence a proteger ici.
                // [27/08] Trace de ce que l'ANCIENNE priorite aurait applique : si un
                // etage inferieur porte une couleur DIFFERENTE de celle du leaf, la ligne
                // ci-dessous le dit. Sur le Scania elle doit sortir ~565 fois avec le
                // jaune #DDDD0D face au gris du leaf — c'est la preuve que l'ecrasement
                // etait bien la cause, conservee pour le jour ou un fichier posera la
                // question inverse.
                if (partCol && gColorTool) {
                    Quantity_Color dq;
                    bool got = false;
                    TDF_Label dLab;
                    if (gShapeTool && gShapeTool->FindSubShape(leaf.resolvedLabel, rawPart, dLab))
                        got = gColorTool->GetColor(dLab, XCAFDoc_ColorSurf, dq)
                           || gColorTool->GetColor(dLab, XCAFDoc_ColorGen,  dq)
                           || gColorTool->GetColor(dLab, XCAFDoc_ColorCurv, dq);
                    if (!got) got = gColorTool->GetColor(rawPart, XCAFDoc_ColorSurf, dq);
                    if (got && !dq.IsEqual(*partCol)) {
                        double lr, lg, lb, dr, dg, db;
                        occtColorToSRGB(*partCol, lr, lg, lb);
                        occtColorToSRGB(dq, dr, dg, db);
                        std::ostringstream od;
                        od << "[COLOR-KEPT-LEAF] \"" << leaf.name.substr(0,40) << "\" leaf=("
                           << lr << "," << lg << "," << lb << ") ignored subshape=("
                           << dr << "," << dg << "," << db << ")\n";
                        logFileOnly(od.str());
                    }
                }

                if (partCol) {
                    // [26/08] log en sRGB = valeurs du fichier : medusa.log devient
                    // directement comparable a FreeCAD / Fusion / CAD Assistant.
                    double lr, lg, lb;
                    occtColorToSRGB(*partCol, lr, lg, lb);
                    std::ostringstream oss;
                    // [31/08] DEUX chemins imprimes, pas un. `path` est celui du
                    // niveau SOUS-SOLIDE ; `leafpath` dit comment la couleur du
                    // leaf a ete obtenue en amont. Quand path=tierA-leaf — le cas
                    // ordinaire — c'est leafpath qui porte toute l'information, et
                    // il manquait. Chercher "leafpath=face-uniform-override" pour
                    // voir les corps ou la couleur des faces a ecrase celle du
                    // solide ; "faces=oui" pour ceux qui partent en multi-groupes.
                    oss << "[COLOR] \"" << leaf.name.substr(0,40) << "\" RGB("
                        << lr << "," << lg << "," << lb
                        << ") path=" << partColPath
                        << " leafpath=" << leaf.colPath
                        << " faces=" << (leaf.faceColors ? "yes" : "no") << "\n";
                    logFileOnly(oss.str());
                } else {
                    logFileOnly("[COLOR] \"" + leaf.name.substr(0,40) + "\" none found (leaf/solid/face all empty)\n");
                }
                // [18/09] Opacite du sous-solide. Elle n'a besoin d'etre cherchee
                // que si la couleur vient de CET etage : quand le leaf en avait une,
                // partCol EST leaf.color et son alpha est deja celui du leaf.
                // Limite connue et assumee : le tout dernier repli "tierB-face-*"
                // (premiere face coloree d'un solide sans couleur ni carte) garde
                // l'opacite du leaf — ce chemin ne concerne que des corps dont
                // aucun etage ne portait de style propre.
                float partAlpha = leaf.alpha;
                if (!leaf.color && partCol && gColorTool) {
                    Quantity_ColorRGBA prgba;
                    if ((!subLabel.IsNull()
                         && (gColorTool->GetColor(subLabel, XCAFDoc_ColorSurf, prgba)
                          || gColorTool->GetColor(subLabel, XCAFDoc_ColorGen,  prgba)
                          || gColorTool->GetColor(subLabel, XCAFDoc_ColorCurv, prgba)))
                     || gColorTool->GetColor(rawPart, XCAFDoc_ColorSurf, prgba)
                     || gColorTool->GetColor(rawPart, XCAFDoc_ColorGen,  prgba)
                     || gColorTool->GetColor(rawPart, XCAFDoc_ColorCurv, prgba))
                        partAlpha = prgba.Alpha();
                }

                jobs.push_back({part, leaf.name, partCol,
                                leaf.deflection, leaf.faceColors, partAlpha});
            }

            // Barre RESOLUTION — throttlee par LEAF (pas par solide individuel :
            // le nombre total de solides n'est connu qu'a la fin de cette boucle,
            // impossible a utiliser comme denominateur pendant qu'elle tourne).
            // Granularite legerement plus grossiere que TESSELLATION mais suffit
            // a donner un signe de vie continu sur un gros assemblage (Scania
            // 1449 corps) — plus aucun [COLOR] en clair pour l'interrompre.
            resolveLeafIdx++;
            if (!leaves.empty()) {
                int pct = (int)(100.0 * resolveLeafIdx / leaves.size());
                int prevPct = (int)(100.0 * (resolveLeafIdx - 1) / leaves.size());
                if (pct != prevPct || resolveLeafIdx == leaves.size()) {
                    std::string shortName = leaf.name.substr(0, 18);
                    drawBarLine("RESOLUTION",
                        (double)resolveLeafIdx / leaves.size(),
                        std::to_string(pct) + "%  (" + std::to_string(resolveLeafIdx) + "/" + std::to_string(leaves.size()) + ")  " + shortName);
                }
            }
        }

        msResolve = ms(tPhase, Clock::now()); tPhase = Clock::now();
        // [15/08] PHASE B (parallèle) — repair + tessellation + extraction, un
        // thread par cœur (parallelForIndices, défini plus haut). Chaque job est
        // 100% autonome (shape + couleur + déflection déjà résolues en phase A) :
        // aucun accès au document XCAF ici, donc aucun risque sur gColorTool/
        // gShapeTool. `jobResults[i]` reçoit 0 ou 1 MeshData (extractInto peut ne
        // rien produire sur une géométrie dégénérée, comme avant) ; l'ordre de
        // `jobs` — donc l'ordre final de `meshes` — est préservé par la
        // compaction séquentielle après le join, même si les threads terminent
        // dans un ordre différent. Pour /stepstream, le sink() est appelé DANS
        // l'ordre de complétion (pas l'ordre des jobs) — sans impact : le but du
        // streaming est un affichage progressif côté client, pas un ordre garanti.
        std::vector<std::vector<MeshData>> jobResults(jobs.size());
        // [24/09] Le B-Rep EXACT de chaque job, tel que lu dans le fichier (avant
        // toute reparation de maillage) : c'est lui que l'export reecrira.
        impEntry->parts.resize(jobs.size());
        for (size_t i = 0; i < jobs.size(); i++) {
            ExactPart& ep = impEntry->parts[i];
            ep.part = jobs[i].part; ep.faceColors = jobs[i].faceColors; ep.a = jobs[i].alpha;
            if (jobs[i].color) {
                Standard_Real cr, cg, cb; jobs[i].color->Values(cr, cg, cb, Quantity_TOC_sRGB);
                ep.hasColor = true; ep.r = (float)cr; ep.g = (float)cg; ep.b = (float)cb;
            }
        }
        signParts(*impEntry, 0);
        if (exactOnly && !impEntry->parts.empty()) return finishExactOnly();
        std::vector<double> jobDefl(jobs.size(), 0.0); // [17/09] rempli en parallele, lu apres le join
        std::atomic<size_t> tessDone{0};
        std::atomic<int> faceCounter{0};
        size_t lastDrawnTess = 0;
        ShapeLockTable shapeLocks;
        std::mutex sinkMx; // protege les ecritures socket du sink /stepstream (frames NSTS non-entrelacables)
        const int detached0 = gDetachedCount.load();   // [24/09] cf. ImportEntry::keepTriangulation
        barPhaseStart();
        parallelForIndices(jobs.size(), 0, [&](size_t i) {
            const PartJob& job = jobs[i];
            // [17/09] Deflexion de FreeCAD, calculee ICI et non plus en phase A.
            // Elle ne depend que de la FORME : deux instances d'un meme prototype
            // obtiennent la meme valeur et partagent donc leur maillage via le
            // cache Poly_Triangulation d'OCCT, exactement comme avant.
            const double jobDeflection = bodyDeflection(job.part, job.deflectionCap);
            jobDefl[i] = jobDeflection;
            TopoDS_Shape workPart = repairIfOpen(job.part, job.name, gRepairedCount);
            bool meshed = false;
            {
                // [15/08] Verrou par TShape : seule la tessellation ecrit dans le cache
                // OCCT partage entre instances d'un meme prototype — repair/extract
                // travaillent sur des donnees locales au job, pas de verrou necessaire.
                std::lock_guard<std::mutex> lk(shapeLocks.forShape(workPart));
                meshed = tessellateShape(workPart, jobDeflection, job.deflectionCap, job.name);
            }
            // [24/09] Forme occupee par un mesheur detache : le cache exact la
            // lache (ni export, ni nettoyage), le corps part en maillage s'il
            // revient un jour — jamais un acces concurrent.
            if (!meshed && tessIsZombie(workPart)) impEntry->parts[i].part.Nullify();
            // [PERF 18/08] faces deja compte PAR extractInto pendant son propre
            // parcours TopExp_Explorer(FACE) de workPart — plus besoin de reparcourir
            // la meme topologie une 2e fois rien que pour ce compteur (cf. son
            // commentaire). Valeur identique, une seule traversee au lieu de deux.
            // [FIX 17/09 soir] Corps abandonne = corps absent, comme l'annonce le
            // [WARN] : on n'extrait pas une triangulation qu'un mesheur detache
            // peut encore etre en train d'ecrire.
            int faces = meshed ? extractInto(workPart, job.name, job.color, jobResults[i], job.faceColors.get(), job.alpha) : 0;
            if (!jobResults[i].empty()) jobResults[i].back().ref = exactRef(*impEntry, i);
            faceCounter.fetch_add(faces);
            if (!jobResults[i].empty()) {
                logRawManifoldCheck(jobResults[i].back());
                if (sink) {
                    std::lock_guard<std::mutex> lk(sinkMx);
                    sink(jobResults[i].back());
                }
            }

            // Barre TESSELLATION : granularité par PART (plus fine que l'ancienne
            // granularité par LEAF), throttlée aux paliers de 1% comme avant. Le nom
            // affiché est celui de la pièce qui VIENT de finir sur ce thread — avec N
            // pièces en vol simultanément, il n'y a plus une seule "pièce en cours",
            // donc on affiche la dernière complétion plutôt qu'une fausse impression
            // de séquentialité. `lastDrawnTess` (sous gConsoleMutex) garantit que le
            // pourcentage affiché ne recule jamais malgré l'ordre de complétion non
            // déterministe entre threads.
            size_t done = tessDone.fetch_add(1) + 1;
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            if (done > lastDrawnTess) {
                int pct = (int)(100.0 * done / jobs.size());
                int prevPct = (int)(100.0 * lastDrawnTess / jobs.size());
                if (pct != prevPct || done == jobs.size()) {
                    std::string shortName = job.name.substr(0, 18);
                    drawBarLine("TESSELLATION",
                        (double)done / jobs.size(),
                        std::to_string(pct) + "%  (" + std::to_string(done) + "/" + std::to_string(jobs.size()) + ")  " + shortName + repairManifoldSuffix());
                }
                lastDrawnTess = done;
            }
        });

        msTess = ms(tPhase, Clock::now());
        if (gDetachedCount.load() != detached0) impEntry->keepTriangulation = true;

        // [17/09] Ce que la deflexion de FreeCAD a decide, agrege sur tous les
        // corps — deplace ici parce qu'elle est desormais calculee en phase B.
        if (!jobDefl.empty()) {
            std::vector<double> dv = jobDefl;
            double cap = 0.0;
            for (const auto& j : jobs) if (j.deflectionCap > cap) cap = j.deflectionCap;
            std::sort(dv.begin(), dv.end());
            std::ostringstream oss;
            oss << "[DEFLECTION] " << dv.size() << " bodies | per-body min=" << dv.front()
                << " p50=" << dv[dv.size() / 2] << " max=" << dv.back()
                << " mm | root cap=" << cap << " mm | deviation=" << (gDeviation * 100.0)
                << "% | budget/body=" << gTriBudgetPerBody << "\n";
            logFileOnly(oss.str());
        }
        {
            std::ostringstream oss;
            oss << "[PHASES] parsing=" << (long long)msParse << " ms | resolution="
                << (long long)msResolve << " ms | tessellation=" << (long long)msTess << " ms\n";
            logFileOnly(oss.str());
        }

        outFaceCount += faceCounter.load();
        for (auto& jr : jobResults) for (auto& md : jr) meshes.push_back(std::move(md));
        // [16/09] Un corps abandonne est une piece ABSENTE du modele affiche. Ca ne
        // doit pas passer inapercu dans un journal de plusieurs milliers de lignes :
        // c'est la seule ligne de cette fonction qui sorte en clair sur la console.
        if (gAbandonedCount.load() > 0) {
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            std::cerr << "[WARN] " << gAbandonedCount.load() << " body(ies) could not be tessellated "
                      << "and are MISSING from this import (see the [WARN] lines above).\n";
        }
        // [17/09] Un thread detache ne meurt JAMAIS : il continue de mailler, a la
        // deflexion fine, pour toute la vie du processus. Mesure sur le balayage du
        // 17/09 : la phase parsing+resolution, qui ne depend d'aucun reglage, est
        // passee de 111 a 161 s au fil des cinq passes, en suivant exactement le
        // nombre cumule de threads detaches (2, 4, 4, 5, 6) sur un pool de 6. Le
        // serveur se degradait en silence, et le banc mesurait sa propre pollution.
        // Desormais il le dit — et il le dit a chaque import, pas une seule fois.
        if (gDetachedCount.load() > 0) {
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            std::cerr << "[WARN] " << gDetachedCount.load()
                      << " runaway mesher thread(s) still alive since this server started. "
                      << "They keep burning cores and slow down EVERY later import. "
                      << "Restart MEDUSA to get full speed back.\n";
        }
    }

    // Fallback : XCAF vide (0 free shape, ou aucune feuille trouvée) -> lecture
    // brute avec le reader simple (un seul mesh, sans nom/couleur).
    if (meshes.empty()) {
        STEPControl_Reader reader;
        std::istringstream stream2(body, std::ios::binary);
        IFSelect_ReturnStatus stat2 = reader.ReadStream("medusa_input.step", stream2);
        if (stat2 != IFSelect_RetDone) throw std::runtime_error("STEP parsing failed (native reader)");
        reader.TransferRoots();
        TopoDS_Shape shape = reader.OneShape();
        if (shape.IsNull()) throw std::runtime_error("STEP: no shape transferred");
        gRootDeflection = rootDeflectionLikeOcctImportJs(shape);
        double fbDeflection = gRootDeflection; // [15/08] capture par valeur — voir commentaire tessellateShape
        // [FIX 17/09 soir] Ce chemin ne passe pas par la remise a zero du chemin
        // XCAF : sans celle-ci, une adresse de TShape libere a l'import precedent,
        // recyclee ici, serait prise pour « deja maillee » et sortirait vide.
        gAbandonedCount = 0;
        tessMemoReset();
        // Meme enumeration multi-corps que le chemin XCAF : solides -> shells hors
        // solides -> shape entiere en dernier recours. Sans ca, tout fichier passant
        // par le fallback (AP203 minimal, chunk degrade, XCAF en echec) ressortait
        // FUSIONNE en un seul mesh — la regression corrigee en v1.1 ressurgissait
        // par cette porte-la.
        std::vector<TopoDS_Shape> fbParts;
        for (TopExp_Explorer se(shape, TopAbs_SOLID); se.More(); se.Next()) fbParts.push_back(se.Current());
        for (TopExp_Explorer he(shape, TopAbs_SHELL, TopAbs_SOLID); he.More(); he.Next()) fbParts.push_back(he.Current());
        if (fbParts.empty()) fbParts.push_back(shape);

        // [16/09] Deflection par corps, calculee SEQUENTIELLEMENT ici, avant la
        // boucle parallele. Meme raison que la phase A du chemin XCAF : la mesure
        // parcourt la topologie (BRepAdaptor sur faces et aretes), et ce fichier a
        // pour regle de ne pas faire de traversee partagee pendant la phase
        // parallele. Le cout est negligeable (une passe de lecture par corps).
        std::vector<double> fbDefl(fbParts.size(), fbDeflection);
        for (size_t i = 0; i < fbParts.size(); ++i)
            fbDefl[i] = bodyDeflection(fbParts[i], fbDeflection);

        // [15/08] Meme parallelisation que le chemin XCAF (voir PHASE B plus haut) —
        // pas de document XCAF ici (fallback = pas de nom/couleur), donc pas de
        // phase sequentielle separee necessaire : chaque partie est deja autonome.
        std::vector<std::vector<MeshData>> fbResults(fbParts.size());
        const size_t fbBase = impEntry->parts.size();       // [24/09] cf. ImportEntry
        impEntry->parts.resize(fbBase + fbParts.size());
        for (size_t i = 0; i < fbParts.size(); i++) impEntry->parts[fbBase + i].part = fbParts[i];
        signParts(*impEntry, fbBase);
        if (exactOnly) return finishExactOnly();
        std::atomic<size_t> fbDone{0};
        std::atomic<int> fbFaceCounter{0};
        size_t lastDrawnFb = 0;
        ShapeLockTable shapeLocks;
        std::mutex sinkMx;
        const int fbDetached0 = gDetachedCount.load();   // [24/09] cf. ImportEntry::keepTriangulation
        barPhaseStart();
        parallelForIndices(fbParts.size(), 0, [&](size_t i) {
            std::string name = "Body_" + std::to_string(i + 1);
            TopoDS_Shape workPart = repairIfOpen(fbParts[i], name, gRepairedCount);
            bool meshed = false;
            {
                std::lock_guard<std::mutex> lk(shapeLocks.forShape(workPart));
                // [16/09] meme politique par corps que le chemin XCAF ci-dessus
                meshed = tessellateShape(workPart, fbDefl[i], fbDeflection, name);
            }
            if (!meshed && tessIsZombie(workPart)) impEntry->parts[fbBase + i].part.Nullify();   // [24/09] cf. phase B
            // [PERF 18/08] meme fusion que dans la boucle PHASE B ci-dessus — voir
            // le commentaire pres de extractInto().
            // [FIX 17/09 soir] meme regle : corps abandonne = rien a extraire.
            int faces = meshed ? extractInto(workPart, name, std::nullopt, fbResults[i]) : 0;
            if (!fbResults[i].empty()) fbResults[i].back().ref = exactRef(*impEntry, fbBase + i);
            fbFaceCounter.fetch_add(faces);
            if (!fbResults[i].empty() && sink) {
                std::lock_guard<std::mutex> lk(sinkMx);
                sink(fbResults[i].back());
            }

            size_t done = fbDone.fetch_add(1) + 1;
            std::lock_guard<std::mutex> lk(gConsoleMutex);
            if (done > lastDrawnFb) {
                int pct = (int)(100.0 * done / fbParts.size());
                int prevPct = (int)(100.0 * lastDrawnFb / fbParts.size());
                if (pct != prevPct || done == fbParts.size()) {
                    drawBarLine("TESSELLATION", (double)done / fbParts.size(),
                        std::to_string(pct) + "%  (" + std::to_string(done) + "/" + std::to_string(fbParts.size()) + ")  " + name + repairManifoldSuffix());
                }
                lastDrawnFb = done;
            }
        });
        outFaceCount += fbFaceCounter.load();
        if (gDetachedCount.load() != fbDetached0) impEntry->keepTriangulation = true;
        for (auto& jr : fbResults) for (auto& md : jr) meshes.push_back(std::move(md));
    }

    if (meshes.empty()) throw std::runtime_error("STEP: no tessellable geometry found");
    rememberImport(impEntry);

    {
        std::ostringstream mj;
        mj << "{\"file\":\"" << jsonEscape(metaName) << "\","
           << "\"timestamp\":\"" << jsonEscape(metaTimestamp) << "\","
           << "\"author\":\"" << jsonEscape(metaAuthor) << "\","
           << "\"organization\":\"" << jsonEscape(metaOrg) << "\","
           << "\"originatingSystem\":\"" << jsonEscape(metaSystem) << "\","
           << "\"schema\":\"" << jsonEscape(metaSchema) << "\","
           // [21/09] L'ETIQUETTE, vue de la source. Champ ADDITIF : un client
           // qui l'ignore se comporte comme avant.
           << weldMetaJson() << "}";
        gMetaJson = mj.str();
    }
    gColorTool.Nullify(); // fin de requete : ne pas garder le doc precedent en vie
    gShapeTool.Nullify();

    auto t1 = Clock::now();
    outTessMs = ms(t0, t1);
    if (sink) return {}; // mode streaming : tout est deja parti par le sink, pas de bloc final
    return encodeNSTP(meshes, outTessMs);
}

// ─────────────────────────────────────────────────────────────────────────
// Serveur HTTP minimal (POSIX sockets, mono-thread, séquentiel — usage local
// mono-utilisateur, pas de charge concurrente attendue).
// ─────────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// ── Lissage BFS natif — portage FIDELE de _ppSmooth (Postprocess Worker
// JS, NASSCAD_V4_7_0_DEV.htm) ─────────────────────────────────────────────
// But : deporter le goulot mesure sur import STEP multi-corps (~7 min de
// silence sur 1449 corps, cf. session precedente) — un seul Worker JS
// traitait chaque corps SEQUENTIELLEMENT. Ici : N corps independants,
// traites EN PARALLELE (thread par coeur), chacun avec l'algorithme exact
// du JS (meme tolerance de weld 1e-4, meme ponderation par angle au coin
// Thurmer & Wuthrich 1998, meme sortie non-indexee).
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// [21/09 — Nass] SOUDURE PAR PROXIMITE, CORRIGEE — weldMeshByProximity
// ═══════════════════════════════════════════════════════════════════════════
// La couture par topologie (extractIntoTopo) rend cette soudure inutile pour
// les corps STEP. Elle reste le seul recours pour un maillage qui arrive sans
// topologie : geometrie generee cote client, feuille d'arbre CSG, /csg brut.
// Elle avait deux defauts, et la NOTE de weldMeshLocal n'en decrivait qu'un :
//
//   1. TOLERANCE ABSOLUE. tol=1e-4 quelle que soit l'echelle. A 1400 mm de
//      l'origine le pas du float32 vaut deja ~1,2e-4 : deux sommets qu'OCCT
//      avait calcules identiques en double deviennent deux floats distincts,
//      separes de PLUS que la tolerance, et la soudure les refuse. Elle cesse
//      silencieusement de souder exactement la ou on a besoin d'elle.
//      -> tolerance RELATIVE a la diagonale de la boite englobante, jamais
//         plus serree que l'ancienne valeur (donc aucune regression sur les
//         petits maillages, ou 1e-4 suffisait).
//
//   2. QUANTIFICATION PRISE POUR UNE PROXIMITE. Le code d'origine hache la
//      cle quantifiee et n'accepte que les cles EGALES. Or deux points
//      distants de tol/1000 tombent dans deux cellules differentes s'ils sont
//      a cheval sur une frontiere de grille : ils ne seront jamais soudes,
//      quelle que soit la tolerance. C'est un faux negatif structurel, pas un
//      reglage. -> on indexe par cellule de cote tol, on SONDE les 27 cellules
//         voisines, et on tranche sur la DISTANCE REELLE. Une cellule de cote
//         tol garantit que tout point a distance <= tol est dans l'une d'elles.
//
// NASSCAD_WELD_LEGACY=1 restitue l'ancien comportement a l'identique.
// ═══════════════════════════════════════════════════════════════════════════
static bool weldLegacyForced() {
    static const bool on = [] {
        const char* e = std::getenv("NASSCAD_WELD_LEGACY");
        return (e && e[0] == '1');
    }();
    return on;
}

static void weldMeshByProximity(std::vector<float>& pos, std::vector<uint32_t>& idx) {
    const size_t nVert = pos.size() / 3;
    if (nVert < 2) return;

    float lo[3] = { pos[0], pos[1], pos[2] }, hi[3] = { pos[0], pos[1], pos[2] };
    for (size_t i = 1; i < nVert; ++i)
        for (int k = 0; k < 3; ++k) {
            const float c = pos[i*3+k];
            if (c < lo[k]) lo[k] = c;
            if (c > hi[k]) hi[k] = c;
        }
    const double dx = (double)hi[0]-lo[0], dy = (double)hi[1]-lo[1], dz = (double)hi[2]-lo[2];
    const double diag = std::sqrt(dx*dx + dy*dy + dz*dz);
    double maxAbs = 0.0;
    for (int k = 0; k < 3; ++k) {
        maxAbs = std::max(maxAbs, std::fabs((double)lo[k]));
        maxAbs = std::max(maxAbs, std::fabs((double)hi[k]));
    }
    // DERIVATION DE LA TOLERANCE — c'est le coeur du correctif, et la premiere
    // version que j'ai ecrite etait FAUSSE : elle indexait la tolerance sur la
    // TAILLE de la piece. Or la perte de precision ne depend pas de la taille,
    // elle depend de la DISTANCE A L'ORIGINE. Un boulon de 16 mm place a
    // 1400 mm a une diagonale minuscule et des coordonnees enormes : c'est
    // exactement le cas de production, et une tolerance relative a la
    // diagonale le rate. Le banc d'essai ci-contre attrape precisement ca.
    //
    // Deux doubles EGAUX, arrondis en float32, s'ecartent d'au plus 1 ULP par
    // composante (0,5 ULP chacun, arrondi au plus proche), donc d'au plus
    // sqrt(3) ULP en distance 3D. On prend 4 ULP : la marge couvre un aller-
    // retour supplementaire (une transformation intermediaire, par exemple)
    // sans jamais approcher une vraie dimension mecanique.
    //   a 1400 mm : 1 ULP = 1,2e-4 mm -> tol = 6,7e-4 mm = 0,67 micron.
    // Le plancher a 1e-4 garantit qu'on ne soude JAMAIS moins bien qu'avant ;
    // le terme en diagonale couvre l'erreur accumulee d'une geometrie generee.
    const double kFloat32Ulp = 1.1920929e-7;   // 2^-23
    const double tol = std::max(std::max(1e-4, 4.0 * maxAbs * kFloat32Ulp), 1e-7 * diag);

    // [23/09 — Claude] SONDAGE PAR INDICE ENTIER, PAS PAR COORDONNEE DECALEE.
    // Avant : grid.find(cell(x + a*tol, ...)) — on decalait la COORDONNEE de
    // +-tol puis on refaisait floor(). Pres de 0 l'arrondi flottant casse ce
    // schema : pour z = -3e-31, (z+tol)/tol vaut EXACTEMENT 1.0 et
    // floor(z/tol) vaut -1, donc les trois sondes tombent sur les cases
    // {-1,-1,1} et la case 0 — celle du jumeau a z = +6e-17 — n'est JAMAIS
    // visitee. Resultat mesure (bench Nass 23/09) : toute sphere centree sur
    // Z=0 (couture UV dans ce plan) garde 1 sommet non soude, 4 aretes nues,
    // et Manifold la refuse (NotManifold). Verifie : cylindre et cone en X=0
    // n'etaient PAS touches (leur couture ne tombe pas sur ce cas limite).
    // Correctif : indice de case calcule UNE fois, voisins = indice +-1 exact.
    auto cellIdx = [&](double v) -> int64_t { return (int64_t)std::floor(v / tol); };
    auto cellKey = [](int64_t i, int64_t j, int64_t k) -> uint64_t {
        return ((uint64_t)(uint32_t)i * 73856093ull)
             ^ ((uint64_t)(uint32_t)j * 19349663ull)
             ^ ((uint64_t)(uint32_t)k * 83492791ull);
    };

    std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
    grid.reserve(nVert * 2);
    std::vector<uint32_t> remap(nVert);
    std::vector<float> welded; welded.reserve(pos.size());
    const double tol2 = tol * tol;

    for (size_t i = 0; i < nVert; ++i) {
        const double x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
        const int64_t ci = cellIdx(x), cj = cellIdx(y), ck = cellIdx(z);
        int found = -1;
        for (int a = -1; a <= 1 && found < 0; ++a)
        for (int b = -1; b <= 1 && found < 0; ++b)
        for (int c = -1; c <= 1 && found < 0; ++c) {
            auto it = grid.find(cellKey(ci + a, cj + b, ck + c));
            if (it == grid.end()) continue;
            for (uint32_t w : it->second) {
                const double ex = (double)welded[(size_t)w*3]   - x;
                const double ey = (double)welded[(size_t)w*3+1] - y;
                const double ez = (double)welded[(size_t)w*3+2] - z;
                if (ex*ex + ey*ey + ez*ez <= tol2) { found = (int)w; break; }
            }
        }
        if (found >= 0) { remap[i] = (uint32_t)found; continue; }
        const uint32_t w = (uint32_t)(welded.size() / 3);
        welded.push_back(pos[i*3]); welded.push_back(pos[i*3+1]); welded.push_back(pos[i*3+2]);
        grid[cellKey(ci, cj, ck)].push_back(w);
        remap[i] = w;
    }
    for (auto& v : idx) v = remap[v];
    pos = std::move(welded);
}


// ═════════════════════════════════════════════════════════════════════════════
// [19/09] POST /ifc — import IFC natif.
//
// Le lecteur (namespace nasifc) ne produit que des TopoDS_Shape nommes et
// colories. TOUT l aval est celui du STEP, sans une ligne dupliquee :
// bodyDeflection (regle FreeCAD du 17/09), tessellateShape et son filet de
// securite par piece, extractInto et ses plages de couleur par face, la chaine
// de reparation manifold du 19/09, encodeNSTP. Un IFC arrive donc dans NASSCAD
// avec exactement les memes garanties qu un STEP.
static std::vector<uint8_t> processIfcBuffer(const std::string& body, double deflectionOverride,
                                             double& outTessMs, int& outFaceCount) {
    auto t0 = Clock::now();
    // [22/09] Memes compteurs remis a zero que dans processStepBuffer : l aval
    // d un IFC est STRICTEMENT celui d un STEP, y compris la couture par
    // topologie du 21/09. Un import doit partir d un compteur propre, sinon le
    // bilan de fin melange deux requetes.
    gRepairedCount = 0;
    gPartialRepairCount = 0;
    gManifoldIssueCount = 0;
    gAbandonedCount = 0;
    tessMemoReset();
    gWeldBodies = 0; gWeldWatertight = 0; gWeldFallback = 0;
    gWeldEdgesTopo = 0; gWeldEdgesResidual = 0; gWeldEdgesMismatch = 0;
    gWeldTrisDropped = 0;
    gWeldFacesFilled = 0; gWeldDiagFlips = 0;   // [FIX 27/09]

    nasifc::Model M = nasifc::parse(body);
    if (M.empty()) throw std::runtime_error("/ifc: no entity found (not an ISO-10303-21 file?)");
    const double scale = nasifc::lengthScale(M);
    nasifc::gAngleToRad = nasifc::angleScale(M);
    nasifc::Reader R(M, scale);
    R.collectStyles();
    auto tParse = Clock::now();

    // Produits porteurs de geometrie : le 7e argument pointe un
    // IfcProductDefinitionShape. Critere structurel, qui ne depend d aucune liste
    // de types a tenir a jour au fil des schemas.
    std::vector<uint32_t> products;
    for (const auto& kv : M) {
        const nasifc::Ent& e = kv.second;
        if (e.args.size() < 7) continue;
        auto it = M.find(nasifc::refOf(e.args[6]));
        if (it != M.end() && it->second.type == "IFCPRODUCTDEFINITIONSHAPE")
            products.push_back(kv.first);
    }
    std::sort(products.begin(), products.end());

    // Percements : en IFC une fenetre ne perce pas le mur dans la geometrie, le
    // percement est une RELATION. Les ignorer donne des murs pleins avec les
    // fenetres posees devant.
    std::unordered_map<uint32_t, std::vector<uint32_t>> voids;
    for (const auto& kv : M) {
        const nasifc::Ent& e = kv.second;
        if (e.type != "IFCRELVOIDSELEMENT" || e.args.size() < 6) continue;
        uint32_t w = nasifc::refOf(e.args[4]), o = nasifc::refOf(e.args[5]);
        if (w && o) voids[w].push_back(o);
    }

    // Etage de chaque element : sert a nommer, donc a peupler l arborescence.
    std::unordered_map<uint32_t, std::string> storey;
    for (const auto& kv : M) {
        const nasifc::Ent& e = kv.second;
        if (e.type != "IFCRELCONTAINEDINSPATIALSTRUCTURE" || e.args.size() < 6) continue;
        auto st = M.find(nasifc::refOf(e.args[5]));
        std::string nm = (st != M.end() && st->second.args.size() > 2) ? nasifc::txtOf(st->second.args[2]) : std::string();
        for (uint32_t x : nasifc::refsOf(e.args[4])) storey[x] = nm;
    }

    // Deflexion de reference : bbox globale, comme la racine d un STEP.
    struct Built { uint32_t pid; TopoDS_Shape shape; nasifc::Style style; bool hasStyle;
                   nasifc::Reader::Mesh mesh; bool isMesh = false; };
    std::vector<Built> built;
    built.reserve(products.size());
    Bnd_Box gbox;
    int nBuilt = 0, nSkip = 0, nFail = 0, nPierced = 0;

    barPhaseStart();
    for (size_t k = 0; k < products.size(); k++) {
        const uint32_t pid = products[k];
        const nasifc::Ent& pe = M[pid];
        if (pe.type == "IFCOPENINGELEMENT") continue;   // outil de coupe, pas un objet
        if (!R.hasBody(pid)) { nSkip++; continue; }     // 2D : annotation, axe, empreinte
        std::vector<nasifc::Reader::Piece> pieces;
        // [22/09] Un produit PERCE repasse par les formes OCCT : le booleen des
        // IfcRelVoidsElement a besoin d'un solide, pas d'un maillage.
        const bool pierceMe = voids.count(pid) != 0;
        try { R.productPieces(pid, pieces, !pierceMe); } catch (...) {}
        if (pieces.empty()) { nFail++; continue; }
        // Les outils de percement se soustraient a CHAQUE morceau : un mur en
        // deux materiaux doit etre perce des deux cotes.
        auto vi = voids.find(pid);
        if (vi != voids.end()) {
            for (uint32_t o : vi->second) {
                TopoDS_Shape tool;
                try { tool = R.productShape(o); } catch (...) { continue; }
                if (tool.IsNull()) continue;
                bool any = false;
                for (auto& pc : pieces) {
                    if (pc.isMesh) continue;
                    try {
                        BRepAlgoAPI_Cut c(pc.shape, tool); c.Build();
                        if (c.IsDone() && !c.Shape().IsNull()) { pc.shape = c.Shape(); any = true; }
                    } catch (...) {}
                }
                if (any) nPierced++;
            }
        }
        for (auto& pc : pieces) {
            if (pc.isMesh) {
                for (size_t q = 0; q + 2 < pc.mesh.pos.size(); q += 3)
                    gbox.Add(gp_Pnt(pc.mesh.pos[q], pc.mesh.pos[q+1], pc.mesh.pos[q+2]));
                built.push_back(Built{pid, TopoDS_Shape(), pc.style, pc.hasStyle,
                                      std::move(pc.mesh), true});
                continue;
            }
            try { BRepBndLib::Add(pc.shape, gbox, Standard_False); } catch (...) {}
            built.push_back(Built{pid, pc.shape, pc.style, pc.hasStyle, {}, false});
        }
        nBuilt++;
        int pct = (int)(100.0 * (k + 1) / products.size());
        int prev = (int)(100.0 * k / products.size());
        if (pct != prev || k + 1 == products.size())
            drawBarLine("IFC", (double)(k + 1) / products.size(),
                        std::to_string(pct) + "%  (" + std::to_string(nBuilt) + " bodies)");
    }
    auto tBuild = Clock::now();

    gRootDeflection = 1.0;
    if (!gbox.IsVoid()) {
        gp_Pnt lo = gbox.CornerMin(), hi = gbox.CornerMax();
        double avg = ((hi.X()-lo.X()) + (hi.Y()-lo.Y()) + (hi.Z()-lo.Z())) / 3.0;
        gRootDeflection = std::max(avg * 0.001, 0.005);
    }
    const double dRef = (deflectionOverride > 0) ? deflectionOverride : gRootDeflection;

    // Tessellation + extraction : STRICTEMENT le chemin STEP.
    std::vector<MeshData> meshes;
    meshes.reserve(built.size());
    barPhaseStart();
    for (size_t k = 0; k < built.size(); k++) {
        const uint32_t pid = built[k].pid;
        const TopoDS_Shape& sh = built[k].shape;
        const nasifc::Ent& pe = M[pid];
        std::string nm = (pe.args.size() > 2) ? nasifc::txtOf(pe.args[2]) : std::string();
        if (nm.empty()) nm = std::string(pe.type);
        auto sit = storey.find(pid);
        if (sit != storey.end() && !sit->second.empty()) nm = sit->second + " / " + nm;

        std::optional<Quantity_Color> col;
        float alpha = 1.0f;
        nasifc::Style st = built[k].style;
        if (built[k].hasStyle) {
            // Les couleurs IFC sont en sRGB, comme celles qu on lit des STEP.
            col = Quantity_Color(std::min(1.0, std::max(0.0, (double)st.r)),
                                 std::min(1.0, std::max(0.0, (double)st.g)),
                                 std::min(1.0, std::max(0.0, (double)st.b)),
                                 Quantity_TOC_sRGB);
            alpha = std::min(1.0f, std::max(0.0f, st.a));
        }
        // [22/09] Piece deja maillee : elle NE PASSE PAS par le mailleur.
        // C'est tout l'interet — le fichier donnait des triangles, on rend ces
        // triangles. Meme structure MeshData que la sortie d'extractInto, donc
        // tout l'aval (couture nasweld, NSTP, client) est inchange.
        if (built[k].isMesh) {
            MeshData md;
            md.name = nm;
            // occtColorToSRGB, PAS Quantity_Color::Red(). Cet accesseur rend la
            // composante LINEAIRE ; tout le reste du moteur ecrit du sRGB, et
            // le bandeau de occtColorToSRGB dit precisement pourquoi. Avec
            // Red(), chaque corps passe par ce chemin ressortait plus sombre
            // que le meme corps passe par extractInto : 0,0423 au lieu de
            // 0,3140 sur un gris moyen.
            if (col) { double sr, sg, sb; occtColorToSRGB(*col, sr, sg, sb);
                       md.hasColor = true;
                       md.r = (float)sr; md.g = (float)sg; md.b = (float)sb; }
            md.a = alpha;
            md.positions = std::move(built[k].mesh.pos);
            md.indices   = std::move(built[k].mesh.idx);
            outFaceCount += (int)(md.indices.size() / 3);
            meshes.push_back(std::move(md));
            int pctm = (int)(100.0 * (k + 1) / built.size());
            int prevm = (int)(100.0 * k / built.size());
            if (pctm != prevm || k + 1 == built.size())
                drawBarLine("TESSELLATION", (double)(k + 1) / built.size(),
                            std::to_string(pctm) + "%  (" + std::to_string(meshes.size()) + " meshes)"
                            + repairManifoldSuffix());
            continue;
        }
        // [22/09] repairIfOpen, comme le chemin STEP. Il manquait ici, et ca
        // se voyait : une sphere ou un cone analytiques ressortaient OUVERTS,
        // parce qu'une surface fermee maillee par OCCT porte une couture dont
        // les sommets sont dedoubles. Le commentaire plus haut promettait
        // « STRICTEMENT le chemin STEP » — il l'est maintenant.
        TopoDS_Shape work = repairIfOpen(sh, nm, gRepairedCount);
        const double defl = bodyDeflection(work, dRef);
        if (!tessellateShape(work, defl, dRef, nm)) continue;
        outFaceCount += extractInto(work, nm, col, meshes, nullptr, alpha);
        int pct = (int)(100.0 * (k + 1) / built.size());
        int prev = (int)(100.0 * k / built.size());
        if (pct != prev || k + 1 == built.size())
            drawBarLine("TESSELLATION", (double)(k + 1) / built.size(),
                        std::to_string(pct) + "%  (" + std::to_string(meshes.size()) + " meshes)"
                        + repairManifoldSuffix());
    }
    auto tTess = Clock::now();
    outTessMs = ms(tBuild, tTess);

    {
        std::ostringstream oss;
        oss << "  IFC: " << M.size() << " entities, scale x" << scale
            << ", " << nBuilt << " built, " << nSkip << " non-3D skipped, "
            << nFail << " failed, " << nPierced << " openings cut"
            << ", " << R.nMeshDirect << " face sets read as mesh"
            << (R.nMeshTriFail ? (", " + std::to_string(R.nMeshTriFail) + " facets ear-clip failed ("
                                  + std::to_string(R.nMeshFan) + " fanned, "
                                  + std::to_string(R.nMeshNoHole) + " retried without holes)") : std::string())
            << "  [parse " << (long)ms(t0, tParse) << " ms, build " << (long)ms(tParse, tBuild)
            << " ms, tess " << (long)ms(tBuild, tTess) << " ms]\n";
        logFileOnly(oss.str());
    }
    if (!R.unsupported.empty()) {
        std::ostringstream oss;
        oss << "  IFC: unsupported entities:";
        for (const auto& kv : R.unsupported) oss << ' ' << kv.first << " x" << kv.second;
        oss << '\n';
        logFileOnly(oss.str());
    }
    // [19/09] Zero corps n est PAS « pas de geometrie ». Un IFC peut etre plein
    // de solides ecrits dans une representation qu on ne sait pas encore lire —
    // et rendre un NSTP vide faisait afficher au client « No geometry found in
    // the STEP file », faux sur les deux mots. On repond donc en NOMMANT ce
    // qu on a rencontre : c est la seule chose qui permette d ajouter le bon cas.
    if (meshes.empty()) {
        std::ostringstream oss;
        oss << "IFC: no body could be built from " << M.size() << " entities";
        if (!R.unsupported.empty()) {
            oss << " — unsupported representations:";
            int n = 0;
            for (const auto& kv : R.unsupported) {
                if (++n > 6) { oss << " ..."; break; }
                oss << ' ' << kv.first << " x" << kv.second;
            }
        } else if (products.empty()) {
            oss << " — no IfcProduct carries an IfcProductDefinitionShape";
        } else {
            oss << " — " << nSkip << " product(s) have no 'Body' representation (2D only?)";
        }
        throw std::runtime_error(oss.str());
    }
    gMetaJson.clear();
    return encodeNSTP(meshes, ms(t0, tTess));
}

// Weld par position — DUPLIQUE depuis weldMeshForCSG (/csg) plutot que
// factorise : /csg est deja livre et teste, on ne le touche pas pour ce
// nouvel endpoint. Meme tolerance (1e-4), meme hash open-addressing.
static void weldMeshLocalLegacy(std::vector<float>& pos, std::vector<uint32_t>& idx) {
    const double tol = 1e-4;
    size_t nVert = pos.size() / 3;
    // [FIX] Cles en int64. llround rend un long long ; la troncature en int32
    // debordait silencieusement des |coord| > 214 748 unites (2^31 * tol).
    // Portee reelle de cette troncature : limitee. Des ~10 000 unites le pas du
    // float (9.8e-4 a 10k, 1.6e-2 a 214k) depasse deja tol=1e-4, donc deux
    // floats voisins y sont separes de ~156 cles : une collision modulo 2^32 est
    // improbable, pas systematique. Le correctif supprime surtout une troncature
    // muette, il ne coute rien, et il tiendra si tol change un jour.
    // Le hash tronque toujours en 32 bits (licite pour un hash) ; seule la
    // comparaison exacte garantit la correction, et elle porte desormais sur les
    // 64 bits complets.
    //
    // NOTE — la vraie limite de ce soudage n'est pas la troncature mais tol,
    // fige a 1e-4 quelle que soit l'echelle du modele. Au-dela de ~10 m en mm il
    // ne fusionne plus que les sommets identiques au bit pres : il cesse
    // silencieusement de souder, ce qui laisse des sommets dupliques donc des
    // fissures, donc du non-manifold, precisement sur les gros assemblages.
    // Indexer tol sur la bbox (cf. rootDeflectionLikeOcctImportJs) reglerait ca.
    auto quant = [&](float v){ return (int64_t)std::llround((double)v / tol); };
    std::vector<int64_t> qx(nVert), qy(nVert), qz(nVert);
    for (size_t i = 0; i < nVert; i++) {
        qx[i] = quant(pos[i*3]); qy[i] = quant(pos[i*3+1]); qz[i] = quant(pos[i*3+2]);
    }
    size_t cap = 1; while (cap < nVert * 2) cap <<= 1;
    size_t mask = cap - 1;
    std::vector<int32_t> table(cap, -1);
    std::vector<uint32_t> remap(nVert);
    std::vector<float> welded; welded.reserve(pos.size());
    for (size_t i = 0; i < nVert; i++) {
        size_t h = ((uint32_t)qx[i]*73856093u ^ (uint32_t)qy[i]*19349663u ^ (uint32_t)qz[i]*83492791u) & mask;
        for (;;) {
            int32_t s = table[h];
            if (s == -1) {
                table[h] = (int32_t)i;
                remap[i] = (uint32_t)(welded.size() / 3);
                welded.push_back(pos[i*3]); welded.push_back(pos[i*3+1]); welded.push_back(pos[i*3+2]);
                break;
            }
            if (qx[s]==qx[i] && qy[s]==qy[i] && qz[s]==qz[i]) { remap[i] = remap[s]; break; }
            h = (h + 1) & mask;
        }
    }
    for (auto& v : idx) v = remap[v];
    pos = std::move(welded);
}

// [21/09] Facade : un seul algorithme de soudure derriere les deux noms
// historiques. NASSCAD_WELD_LEGACY=1 rend la main aux deux corps d'origine,
// laisses intacts juste au-dessus.
static void weldMeshLocal(std::vector<float>& pos, std::vector<uint32_t>& idx) {
    if (weldLegacyForced()) { weldMeshLocalLegacy(pos, idx); return; }
    weldMeshByProximity(pos, idx);
}

// Normales de face — produit vectoriel normalise (identique a _ppFN).
static std::vector<float> computeFaceNormalsLocal(const std::vector<float>& pos, const std::vector<uint32_t>& idx) {
    size_t nF = idx.size() / 3;
    std::vector<float> fn(nF * 3);
    for (size_t f = 0; f < nF; f++) {
        uint32_t a = idx[f*3], b = idx[f*3+1], c = idx[f*3+2];
        float ax=pos[a*3], ay=pos[a*3+1], az=pos[a*3+2];
        float bx=pos[b*3], by=pos[b*3+1], bz=pos[b*3+2];
        float cx=pos[c*3], cy=pos[c*3+1], cz=pos[c*3+2];
        float e1x=bx-ax, e1y=by-ay, e1z=bz-az;
        float e2x=cx-ax, e2y=cy-ay, e2z=cz-az;
        float nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
        float L = std::sqrt(nx*nx+ny*ny+nz*nz); if (L < 1e-20f) L = 1.0f;
        fn[f*3]=nx/L; fn[f*3+1]=ny/L; fn[f*3+2]=nz/L;
    }
    return fn;
}

// Angle au coin (poids de la normale lissee) — identique a cornerAngle() JS.
static inline double cornerAngleLocal(const std::vector<float>& pos, const std::vector<uint32_t>& idx,
                                       uint32_t af, uint32_t v) {
    uint32_t a = idx[af*3], b = idx[af*3+1], c = idx[af*3+2];
    uint32_t p, q;
    if (v == a) { p = b; q = c; } else if (v == b) { p = c; q = a; } else { p = a; q = b; }
    double vx=pos[v*3], vy=pos[v*3+1], vz=pos[v*3+2];
    double e1x=pos[p*3]-vx, e1y=pos[p*3+1]-vy, e1z=pos[p*3+2]-vz;
    double e2x=pos[q*3]-vx, e2y=pos[q*3+1]-vy, e2z=pos[q*3+2]-vz;
    double l1 = std::sqrt(e1x*e1x+e1y*e1y+e1z*e1z); if (l1 < 1e-20) l1 = 1.0;
    double l2 = std::sqrt(e2x*e2x+e2y*e2y+e2z*e2z); if (l2 < 1e-20) l2 = 1.0;
    double d = (e1x*e2x+e1y*e2y+e1z*e2z) / (l1*l2);
    if (d > 1.0) d = 1.0; else if (d < -1.0) d = -1.0;
    return std::acos(d);
}

struct SmoothResult { std::vector<float> pos, nrm; std::vector<uint32_t> idx; };
// [11/08] Repair natif (/repair) — cf. RepairResult plus bas dans le handler HTTP ;
// declaree ici pour la meme raison que SmoothResult (portee fichier, style existant).
struct RepairResult { std::vector<float> pos; std::vector<uint32_t> idx; bool repaired; };

// Pipeline complet pour UN mesh : weld -> normales de face -> ilots BFS
// (angle diedre < crease) -> normales ponderees par angle au coin, PUIS
// regroupement par (vertex soude, ilot) -> sortie INDEXEE (cf. commentaire
// detaille dans le corps de la fonction). Un vertex touche par plusieurs
// ilots differents (vraie arete vive) recoit une copie par ilot ; sinon,
// une seule copie partagee par toutes les faces de son ilot.
static SmoothResult smoothMeshBFSLocal(std::vector<float> pos, std::vector<uint32_t> idx, double cosCrease) {
    weldMeshLocal(pos, idx);
    auto fn = computeFaceNormalsLocal(pos, idx);
    size_t nV = pos.size() / 3, nF = idx.size() / 3;

    // v -> f (CSR)
    std::vector<uint32_t> cnt(nV, 0);
    for (size_t i = 0; i < idx.size(); i++) cnt[idx[i]]++;
    std::vector<uint32_t> voff(nV + 1, 0);
    for (size_t v = 0; v < nV; v++) voff[v+1] = voff[v] + cnt[v];
    std::vector<uint32_t> lst(voff[nV]);
    std::vector<uint32_t> fil(nV, 0);
    for (size_t f = 0; f < nF; f++)
        for (int vi = 0; vi < 3; vi++) { uint32_t v = idx[f*3+vi]; lst[voff[v]+fil[v]++] = (uint32_t)f; }

    // edge -> faces (cle numerique a*nV+b, comme EK() en JS)
    std::unordered_map<uint64_t, std::vector<uint32_t>> e2f;
    e2f.reserve(nF * 2);
    auto EK = [nV](uint64_t a, uint64_t b) -> uint64_t { return a < b ? a*(uint64_t)nV+b : b*(uint64_t)nV+a; };
    for (size_t f = 0; f < nF; f++) {
        uint32_t a = idx[f*3], b = idx[f*3+1], c = idx[f*3+2];
        uint64_t pairs[3][2] = {{a,b},{b,c},{c,a}};
        for (auto& pr : pairs) e2f[EK(pr[0], pr[1])].push_back((uint32_t)f);
    }

    // BFS ilots par angle diedre
    std::vector<int32_t> f2i(nF, -1);
    std::vector<uint8_t> vis(nF, 0);
    int32_t nI = 0;
    std::vector<uint32_t> Q;
    for (size_t sF = 0; sF < nF; sF++) {
        if (vis[sF]) continue;
        int32_t iId = nI++;
        Q.clear(); Q.push_back((uint32_t)sF); vis[sF] = 1; f2i[sF] = iId;
        size_t h = 0;
        while (h < Q.size()) {
            uint32_t f = Q[h++];
            uint32_t fa = idx[f*3], fb = idx[f*3+1], fc = idx[f*3+2];
            float fx = fn[f*3], fy = fn[f*3+1], fz = fn[f*3+2];
            uint64_t pairs[3][2] = {{fa,fb},{fb,fc},{fc,fa}};
            for (auto& pr : pairs) {
                auto it = e2f.find(EK(pr[0], pr[1]));
                if (it == e2f.end()) continue;
                for (uint32_t nf : it->second) {
                    if (vis[nf]) continue;
                    double dot = (double)fx*fn[nf*3] + (double)fy*fn[nf*3+1] + (double)fz*fn[nf*3+2];
                    if (dot >= cosCrease) { vis[nf] = 1; f2i[nf] = iId; Q.push_back(nf); }
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Sortie INDEXÉE, regroupée par (vertex soudé, îlot) — pas par (face,
    // coin). Preuve : la normale calculée pour (v, iId) ne dépend QUE de
    // v et iId, jamais de quelle face a déclenché le calcul — deux faces
    // du MÊME îlot touchant le MÊME vertex soudé obtiennent, par construction
    // de la formule, exactement la même normale, à chaque fois.
    //
    // [PERF 07/08] Deux passes sur des buffers PLATS pré-dimensionnés, au
    // lieu d'un std::vector<std::vector<...>> par vertex — mesuré : la V1
    // (un vector separe par vertex, potentiellement des millions de petites
    // allocations heap individuelles) montrait un passage ×6 de temps pour
    // ×4 de travail (non-lineaire) entre 500x500 et 1000x1000 vertices.
    // Cette version : compter d'abord (aucune allocation), prefix-sum pour
    // connaitre la position exacte de chaque vertex dans UN SEUL buffer
    // final, puis remplir directement — deux allocations totales au lieu
    // de potentiellement des millions.
    // ─────────────────────────────────────────────────────────────────────

    // Passe 1 : compter les ilots distincts par vertex (aucune allocation,
    // juste des compteurs).
    std::vector<uint32_t> islCountPerVert(nV, 0);
    for (size_t v = 0; v < nV; v++) {
        for (uint32_t j = voff[v]; j < voff[v+1]; j++) {
            int32_t iId = f2i[lst[j]];
            bool already = false;
            for (uint32_t j2 = voff[v]; j2 < j; j2++) if (f2i[lst[j2]] == iId) { already = true; break; }
            if (!already) islCountPerVert[v]++;
        }
    }

    // Prefix-sum : ou commence la plage de chaque vertex dans le buffer plat.
    std::vector<uint32_t> vOff2(nV + 1, 0);
    for (size_t v = 0; v < nV; v++) vOff2[v+1] = vOff2[v] + islCountPerVert[v];
    uint32_t totalOutV = vOff2[nV];

    // Passe 2 : remplir directement les buffers finaux (position, normale)
    // ET le buffer plat de correspondance (ilot -> index de sortie), a la
    // bonne position, sans jamais reallouer.
    SmoothResult out;
    out.pos.resize(totalOutV * 3);
    out.nrm.resize(totalOutV * 3);
    out.idx.resize(nF * 3);
    std::vector<int32_t> flatIslandIds(totalOutV);   // ilot pour chaque entree plate
    std::vector<uint32_t> fillCursor(nV, 0);          // combien deja rempli pour ce vertex

    for (size_t v = 0; v < nV; v++) {
        for (uint32_t j = voff[v]; j < voff[v+1]; j++) {
            int32_t iId = f2i[lst[j]];
            bool already = false;
            for (uint32_t k = vOff2[v]; k < vOff2[v] + fillCursor[v]; k++)
                if (flatIslandIds[k] == iId) { already = true; break; }
            if (already) continue;

            double nx = 0, ny = 0, nz = 0;
            for (uint32_t j2 = voff[v]; j2 < voff[v+1]; j2++) {
                uint32_t af = lst[j2];
                if (f2i[af] == iId) {
                    double w = cornerAngleLocal(pos, idx, af, (uint32_t)v);
                    nx += fn[af*3] * w; ny += fn[af*3+1] * w; nz += fn[af*3+2] * w;
                }
            }
            double L = std::sqrt(nx*nx+ny*ny+nz*nz); if (L < 1e-20) L = 1.0;
            uint32_t slot = vOff2[v] + fillCursor[v];
            out.pos[slot*3]=pos[v*3]; out.pos[slot*3+1]=pos[v*3+1]; out.pos[slot*3+2]=pos[v*3+2];
            out.nrm[slot*3]=(float)(nx/L); out.nrm[slot*3+1]=(float)(ny/L); out.nrm[slot*3+2]=(float)(nz/L);
            flatIslandIds[slot] = iId;
            fillCursor[v]++;
        }
    }

    // Buffer d'index : chaque coin de triangle référence le vertex de
    // sortie partagé correspondant à (son vertex soudé, l'îlot de SA face).
    for (size_t f = 0; f < nF; f++) {
        int32_t iId = f2i[f];
        for (int vi = 0; vi < 3; vi++) {
            uint32_t v = idx[f*3+vi];
            for (uint32_t k = vOff2[v]; k < vOff2[v+1]; k++) {
                if (flatIslandIds[k] == iId) { out.idx[f*3+vi] = k; break; }
            }
        }
    }
    return out;
}

static int platformRecv(SocketFD fd, char* buf, size_t len) {
#ifdef _WIN32
    return recv(fd, buf, (int)len, 0);
#else
    return (int)recv(fd, buf, len, 0);
#endif
}
static int platformSend(SocketFD fd, const char* buf, size_t len) {
#ifdef _WIN32
    return send(fd, buf, (int)len, 0);
#else
    return (int)send(fd, buf, len, 0);
#endif
}
static bool readAll(SocketFD fd, char* buf, size_t n) {
    size_t got = 0;
    while (got < n) {
        int r = platformRecv(fd, buf + got, n - got);
        if (r <= 0) return false;
        got += (size_t)r;
    }
    return true;
}
static void writeAll(SocketFD fd, const char* buf, size_t n) {
    size_t sent = 0;
    while (sent < n) {
        int w = platformSend(fd, buf + sent, n - sent);
        if (w <= 0) return;
        sent += (size_t)w;
    }
}

struct HttpRequest {
    std::string method, path;
    size_t contentLength = 0;
    std::string body;
};

// Lit une requête HTTP/1.1 simple : ligne de méthode, headers jusqu'à \r\n\r\n,
// puis Content-Length octets de corps si présent. Suffisant pour GET/OPTIONS/POST
// sans corps chunké (fetch() du navigateur envoie un Content-Length explicite).
static bool readHttpRequest(SocketFD fd, HttpRequest& req) {
    std::string buf;
    // [PERF 18/08] 8 Ko -> 64 Ko : sur une grosse requete POST (STEP volumineux),
    // le debut du body arrive tres souvent dans le meme paquet/recv() que la fin
    // des headers — un chunk plus large capture plus de body des le premier tour
    // de cette boucle, moins de recv() au total. Comportement identique (simple
    // buffer de scan), juste moins de syscalls.
    char chunk[65536];
    size_t headerEnd = std::string::npos;
    while (headerEnd == std::string::npos) {
        int r = platformRecv(fd, chunk, sizeof(chunk));
        if (r <= 0) return false;
        buf.append(chunk, r);
        headerEnd = buf.find("\r\n\r\n");
        if (buf.size() > 16 * 1024 * 1024 && headerEnd == std::string::npos) return false; // headers déraisonnables
    }
    std::string headerPart = buf.substr(0, headerEnd);
    std::string already = buf.substr(headerEnd + 4);

    std::istringstream hs(headerPart);
    std::string line;
    std::getline(hs, line);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    {
        std::istringstream ls(line);
        std::string httpver;
        ls >> req.method >> req.path >> httpver;
    }
    size_t contentLength = 0;
    while (std::getline(hs, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        auto colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = line.substr(0, colon);
        std::transform(key.begin(), key.end(), key.begin(), ::tolower);
        if (key == "content-length") {
            std::string val = line.substr(colon + 1);
            size_t p = val.find_first_not_of(" \t");
            // [28/08 AUDIT] Parsing manuel plutot que std::stoul, pour deux raisons.
            // (1) std::stoul LEVE (std::invalid_argument) sur un Content-Length non
            //     numerique. Cette exception remontait jusqu'a la boucle d'accept de
            //     main(), qui ne l'attrape pas -> std::terminate : le moteur
            //     s'eteignait sur une seule requete malformee. Un scan de port ou un
            //     client HTTP mal lune suffisait a tuer le process.
            // (2) std::stoul retourne un unsigned long, soit 32 BITS sous MSVC : un
            //     corps de plus de 4 Gio etait tronque silencieusement (le fichier
            //     documente lui-meme un cas reel a 1,3 Go, on n'est pas si loin).
            // Ici : aucune exception possible, size_t plein, arret propre au premier
            // caractere non numerique, et refus explicite en cas de debordement.
            if (p != std::string::npos) {
                size_t cl = 0; bool ok = false;
                for (size_t k = p; k < val.size(); k++) {
                    unsigned char c = (unsigned char)val[k];
                    if (c < '0' || c > '9') break;
                    size_t d = (size_t)(c - '0');
                    if (cl > (SIZE_MAX - d) / 10) { ok = false; break; }
                    cl = cl * 10 + d;
                    ok = true;
                }
                if (ok) contentLength = cl;
            }
        }
    }
    req.contentLength = contentLength;
    // [PERF 18/08] Lecture du reste du body DIRECTEMENT dans req.body — l'ancienne
    // version lisait dans un std::vector<char> rest temporaire PUIS le recopiait
    // via append(). Sur un gros STEP (le fichier documente lui-meme un cas reel a
    // 1,3 Go, Dante.step), ca faisait exister le corps en double en memoire (rest
    // ET req.body) le temps de l'append, plus un memcpy complet du corps entier.
    // resize() porte req.body a sa taille finale d'un coup, puis readAll() ecrit
    // directement dans son buffer interne (&req.body[haveSize]) — plus aucune
    // copie intermediaire, un seul exemplaire du corps a tout instant.
    req.body = std::move(already);
    if (req.body.size() < contentLength) {
        size_t haveSize = req.body.size();
        req.body.resize(contentLength);
        if (!readAll(fd, &req.body[haveSize], contentLength - haveSize)) return false;
    }
    return true;
}

static const char* CORS_HEADERS =
    "Access-Control-Allow-Origin: *\r\n"
    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    "Access-Control-Allow-Headers: *\r\n"
    "Access-Control-Allow-Private-Network: true\r\n";

// ─── Streaming HTTP chunked (Transfer-Encoding: chunked, RFC 7230) ───
// Permet d'émettre les meshes AU FIL de la tessellation, sans connaître la
// taille totale à l'avance : chaque chunk = taille hex + CRLF + data + CRLF,
// fin = "0\r\n\r\n". Le navigateur (fetch + ReadableStream) reçoit et peut
// afficher progressivement — supprime le "trou noir" entre la fin du calcul
// et l'arrivée du bloc NSTP complet, et le pic mémoire du gros buffer unique.
static void writeChunk(SocketFD fd, const uint8_t* data, size_t len) {
    if (len == 0) return;
    char head[32];
    int n = snprintf(head, sizeof(head), "%zx\r\n", len);
    writeAll(fd, head, n);
    writeAll(fd, (const char*)data, len);
    writeAll(fd, "\r\n", 2);
}
static void writeChunkStr(SocketFD fd, const std::string& s) {
    writeChunk(fd, (const uint8_t*)s.data(), s.size());
}
static void endChunks(SocketFD fd) { writeAll(fd, "0\r\n\r\n", 5); }

// Frame du protocole NSTS (NSTP-Stream) v1, émise par mesh :
//   [u32 jsonLen][json meta][pos float32...][idx uint32...]
// meta = {"name","color","posCount","idxCount"} ; frame finale = {"end":true,...}
// (jsonLen seul, sans binaire). Little-endian, comme NSTP.
static void writeMeshFrame(SocketFD fd, const MeshData& m) {
    std::ostringstream j;
    j << "{\"name\":\"" << jsonEscape(m.name) << "\",";
    if (m.hasColor) j << "\"color\":{\"r\":" << m.r << ",\"g\":" << m.g << ",\"b\":" << m.b << "},";
    else j << "\"color\":null,";
    // [27/08] Identique a encodeNSTP : les deux chemins (/step et /stepstream)
    // doivent emettre le meme champ, sinon le streaming perdrait les couleurs
    // par face que le mode classique conserve.
    if (!m.faces.empty()) {
        j << "\"faces\":[";
        for (size_t g = 0; g < m.faces.size(); g++) {
            if (g) j << ",";
            j << "[" << m.faces[g].r << "," << m.faces[g].g << "," << m.faces[g].b
              << "," << m.faces[g].start << "," << m.faces[g].count << "]";
        }
        j << "],";
    }
    if (!m.ref.empty()) j << "\"ref\":\"" << jsonEscape(m.ref) << "\",";
    if (!m.brep.empty()) j << "\"brep\":\"" << m.brep << "\",";   // [FIX 27/09] idem encodeNSTP
    j << "\"posCount\":" << m.positions.size() << ",\"idxCount\":" << m.indices.size() << "}";
    std::string js = j.str();
    uint32_t jl = (uint32_t)js.size();
    std::vector<uint8_t> frame(4 + jl + m.positions.size()*4 + m.indices.size()*4);
    frame[0]=jl&0xFF; frame[1]=(jl>>8)&0xFF; frame[2]=(jl>>16)&0xFF; frame[3]=(jl>>24)&0xFF;
    std::memcpy(frame.data()+4, js.data(), jl);
    std::memcpy(frame.data()+4+jl, m.positions.data(), m.positions.size()*4);
    std::memcpy(frame.data()+4+jl+m.positions.size()*4, m.indices.data(), m.indices.size()*4);
    writeChunk(fd, frame.data(), frame.size());
}
static void writeJsonFrame(SocketFD fd, const std::string& js) {
    uint32_t jl = (uint32_t)js.size();
    std::vector<uint8_t> frame(4 + jl);
    frame[0]=jl&0xFF; frame[1]=(jl>>8)&0xFF; frame[2]=(jl>>16)&0xFF; frame[3]=(jl>>24)&0xFF;
    std::memcpy(frame.data()+4, js.data(), jl);
    writeChunk(fd, frame.data(), frame.size());
}

static void sendResponse(SocketFD fd, int code, const char* status, const std::string& contentType,
                          const char* body, size_t bodyLen) {
    std::ostringstream head;
    head << "HTTP/1.1 " << code << " " << status << "\r\n"
         << CORS_HEADERS
         << "Content-Type: " << contentType << "\r\n"
         << "Content-Length: " << bodyLen << "\r\n"
         << "Connection: close\r\n\r\n";
    std::string h = head.str();
    writeAll(fd, h.data(), h.size());
    if (bodyLen) writeAll(fd, body, bodyLen);
}

// ═════════════════════════════════════════════════════════════════════════════
// [24/09 — Nass] EXPORT STEP NATIF — POST /stepexport
//
// L'export STEP passe maintenant ENTIEREMENT par MEDUSA, comme l'import. Le
// navigateur ne fait plus qu'une chose : cuire chaque corps en triangles monde
// (makeGeoHD + matrice, ce que lui seul peut faire, la scene vit chez lui) et
// les poster en binaire. Tout le reste est ici :
//   - soudure quantifiee des sommets (tolerance du mode de fusion) ;
//   - merge coplanaire -> MANIFOLD_SOLID_BREP a faces planes, trous compris ;
//   - repli FACETED_BREP / OPEN_SHELL, sphere analytique SPHERICAL_SURFACE ;
//   - assemblage (1 PRODUCT par corps + NAUO), appareil CC d'AP203 ;
//   - couleurs de corps et par face (STYLED_ITEM / OVER_RIDING_STYLED_ITEM),
//     transparence ;
//   - ecriture ISO 10303-21 (echappement \X2\, lignes repliees a 72).
//
// C'est le portage LIGNE A LIGNE de step-export.js (audit STEP du 18/09, relu
// entite par entite contre OCCT 8.0), pas une reinvention : memes entites,
// memes regles, meme fichier a l'arrivee — a l'ordre des #id pres (voir plus
// bas). Le JS reste le repli quand le moteur n'est pas joignable.
//
// POURQUOI PAS STEPCAFControl_Writer, qu'on a sous la main :
//   - il veut un TopoDS_Shape : il faudrait d'abord BATIR le B-Rep OCCT d'un
//     maillage (BRepBuilderAPI_MakePolygon par face + Sewing + MakeSolid), soit
//     exactement l'operation lente qu'on cherche a eviter — le sewing seul se
//     compte en minutes sur quelques centaines de milliers de faces ;
//   - son ecriture est strictement sequentielle (un seul StepData_StepModel) ;
//   - le JS produit deja un fichier valide contre OCCT, FreeCAD, Fusion et
//     l'Autodesk Viewer : on garde CE fichier, on le produit juste 100x plus vite.
// OCCT sert en revanche de JUGE : --selftest-stepexport relit ce qu'on ecrit
// avec STEPCAFControl_Reader et compare volumes, noms et couleurs.
//
// PARALLELISME — les deux etages du chemin d'import, appliques a l'envers :
//   1) PLAN, un corps par tache (parallelForIndices, plus gros corps d'abord) :
//      soudure, merge, topologie. A la fin de cet etage chaque corps connait le
//      NOMBRE EXACT d'entites qu'il va ecrire.
//   2) ECRITURE : une somme prefixe donne a chaque corps son premier #id, puis
//      chaque corps est decoupe en blocs (~32 k entites) dont on connait aussi
//      le #id de depart — sommets, aretes, faces ou triangles. Les blocs sont
//      ecrits en parallele dans des tampons separes et concatenes dans l'ordre.
//      Un corps unique de 5 M de triangles occupe donc tous les coeurs a
//      l'ecriture, pas un seul.
// Consequence sur l'ordre des #id : dans un corps, tous les sommets, puis
// toutes les aretes, puis les faces (le JS les creait paresseusement, face par
// face). Part 21 n'impose aucun ordre ; OCCT, FreeCAD et le NIST SFA lisent les
// deux formes.
//
// Ecarts VOLONTAIRES avec le JS (tous des corrections, aucun ne change un
// fichier qui sortait deja correct) :
//   - la limite « 5000 aretes de bord par face -> tout le corps en facettes »
//     disparait. Elle ne protegeait que le JS de sa propre recherche lineaire
//     (bndPairs.find dans la boucle, O(n2)). Une grande face plane finement
//     triangulee reste une ADVANCED_FACE ;
//   - un triangle dont deux sommets se confondent APRES quantification est
//     ecarte : il donnait une POLY_LOOP a sommet repete, et une arete (a,a)
//     qui faisait passer une coque fermee pour ouverte ;
//   - un sommet de bord a deux aretes sortantes (pincement) fait refuser le
//     merge au lieu d'en perdre une en silence.
//
// PROTOCOLE REQUETE « NSX1 » (little-endian, cf. _stepMedusaRequest cote client)
//   char[4] 'NSX1'
//   u32 ap (0=AP203, 1=AP214, 2=AP242)   u32 mode (0=EXACT, 1=ROBUST, 2=FACETED)
//   u32 keyDec                           f64 tol
//   u32 objCount                         u32 verLen + octets (bourres a 4)
//   u32 bodyCount, puis par corps :
//     u32 kind (0 = maillage, 1 = sphere)
//     u32 nameLen + octets UTF-8 (bourres a 4)
//     u32 baseRGB, f64 baseAlpha
//     u32 palCount, puis palCount x (u32 rgb, f64 alpha)
//     kind 1 : f64 cx, cy, cz, r         (repere Three, Y-up)
//     kind 0 : u32 nVert, u32 nTri, u32 flags (bit0 indexe, bit1 materiau/tri)
//              f32 pos[nVert*3] ; u32 idx[nTri*3] si indexe ; i32 mat[nTri] si bit1
//              (soupe : nVert = 3*nTri)
// REPONSE : [u32 jsonLen][JSON stats][texte STEP]. Erreur : JSON nu, comme les
// autres routes (le client teste le content-type avant de decoder).
// ═════════════════════════════════════════════════════════════════════════════
static const char* cWarn();    // [24/09] couleurs console, definies plus bas
static const char* cReset();
namespace stepx {

static constexpr uint32_t kNone = 0xFFFFFFFFu;
static constexpr size_t   kMaxFaceStyles = 20000;   // _STEP_MAX_FACE_STYLES
static constexpr uint64_t kChunkEntities = 32768;   // grain d'ecriture parallele

// ── Descripteurs AP — copie conforme de STEPApVersions (step-export.js) ──
struct ApInfo {
    const char* name; const char* schema; const char* schemaStyle;
    const char* appCtxText; const char* apdStd; const char* apdName; int apdYear;
    const char* ctxProduct; const char* ctxDefApi; const char* ctxDefName;
    bool srcSpec, ccDesign, hasColors;
};
static const ApInfo kAp[3] = {
    { "AP203", "CONFIG_CONTROL_DESIGN", "SHAPE_APPEARANCE_LAYER_MIM",
      "configuration controlled 3D designs of mechanical parts and assemblies",
      "international standard", "config_control_design", 1994,
      "MECHANICAL_CONTEXT", "DESIGN_CONTEXT", "", true, true, true },
    { "AP214", "AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }", nullptr,
      "core data for automotive mechanical design processes",
      "international standard", "automotive_design", 2000,
      "PRODUCT_CONTEXT", "PRODUCT_DEFINITION_CONTEXT", "part definition", false, false, true },
    { "AP242", "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }", nullptr,
      "Managed model based 3d engineering",
      "international standard", "ap242_managed_model_based_3d_engineering", 2013,
      "PRODUCT_CONTEXT", "PRODUCT_DEFINITION_CONTEXT", "part definition", false, false, true },
};

// ── Litteraux ISO 10303-21 ────────────────────────────────────────────────
// Reel : portage exact de _stepReal (point decimal obligatoire, zeros de queue
// retires, exposant hors [1e-9, 1e15), jamais '-0.').
static void appendReal(std::string& o, double v, int dec) {
    if (!std::isfinite(v)) v = 0;
    const double a = v < 0 ? -v : v;
    char buf[64];
    if (a != 0 && (a >= 1e15 || a < 1e-9)) {
        // toExponential(min(17, dec+3)) -> mantisse, 'E', exposant signe.
        const int p = std::min(17, dec + 3);
        int n = std::snprintf(buf, sizeof(buf), "%.*e", p, v);
        std::string s(buf, n > 0 ? (size_t)n : 0);
        const size_t e = s.find('e');
        std::string m = s.substr(0, e), ex = s.substr(e + 1);
        if (m.find('.') != std::string::npos) {
            while (!m.empty() && m.back() == '0') m.pop_back();
        } else m += '.';
        // exposant : signe explicite, sans zeros de tete (JS : 'e-10', 'e+21')
        char sign = '+';
        size_t k = 0;
        if (!ex.empty() && (ex[0] == '+' || ex[0] == '-')) { sign = ex[0]; k = 1; }
        while (k + 1 < ex.size() && ex[k] == '0') k++;
        o += m; o += 'E'; o += sign; o.append(ex, k, std::string::npos);
        return;
    }
    // std::to_chars et non snprintf : meme arrondi correct que printf (et que
    // toFixed a l'ulp pres), sans locale ni analyse de format — c'est l'appel
    // le plus frequent de tout l'export (3 reels par point, par direction).
    const auto r = std::to_chars(buf, buf + sizeof(buf), v, std::chars_format::fixed, dec);
    if (r.ec != std::errc()) { o += "0."; return; }
    int e = (int)(r.ptr - buf);
    while (e > 0 && buf[e - 1] == '0') e--;           // le point decimal reste
    if (e == 3 && buf[0] == '-' && buf[1] == '0' && buf[2] == '.') { o += "0."; return; }
    o.append(buf, (size_t)e);
}
static inline void appendU(std::string& o, uint64_t v) {
    char b[24]; int n = 0;
    do { b[n++] = char('0' + v % 10); v /= 10; } while (v);
    while (n) o += b[--n];
}
static inline void appendRef(std::string& o, uint64_t id) { o += '#'; appendU(o, id); }

// UTF-8 -> unites UTF-16 (le JS travaille sur des chaines UTF-16 : \X2\ encode
// des UNITES, paires de substitution comprises). Octet invalide -> U+FFFD.
static std::vector<uint16_t> utf8ToUtf16(const std::string& s) {
    std::vector<uint16_t> u; u.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        const unsigned char c = (unsigned char)s[i];
        uint32_t cp = 0xFFFD; size_t len = 1;
        if (c < 0x80) { cp = c; }
        else if ((c >> 5) == 0x6 && i + 1 < s.size() && ((unsigned char)s[i+1] >> 6) == 2) {
            cp = ((c & 0x1Fu) << 6) | ((unsigned char)s[i+1] & 0x3Fu); len = 2;
            if (cp < 0x80) cp = 0xFFFD;
        } else if ((c >> 4) == 0xE && i + 2 < s.size() && ((unsigned char)s[i+1] >> 6) == 2
                   && ((unsigned char)s[i+2] >> 6) == 2) {
            cp = ((c & 0x0Fu) << 12) | (((unsigned char)s[i+1] & 0x3Fu) << 6) | ((unsigned char)s[i+2] & 0x3Fu); len = 3;
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
        } else if ((c >> 3) == 0x1E && i + 3 < s.size() && ((unsigned char)s[i+1] >> 6) == 2
                   && ((unsigned char)s[i+2] >> 6) == 2 && ((unsigned char)s[i+3] >> 6) == 2) {
            cp = ((c & 0x07u) << 18) | (((unsigned char)s[i+1] & 0x3Fu) << 12)
               | (((unsigned char)s[i+2] & 0x3Fu) << 6) | ((unsigned char)s[i+3] & 0x3Fu); len = 4;
            if (cp < 0x10000 || cp > 0x10FFFF) cp = 0xFFFD;
        }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            u.push_back((uint16_t)(0xD800 + (cp >> 10)));
            u.push_back((uint16_t)(0xDC00 + (cp & 0x3FF)));
        } else u.push_back((uint16_t)cp);
        i += len;
    }
    return u;
}
// Chaine : portage exact de _stepStr — '' et \\ doubles, non-ASCII en
// \X2\<UTF-16>\X0\, plafond 200 caracteres encodes (une chaine ne se replie
// pas et la norme interdit les lignes de plus de 256), jamais de demi-paire.
// cutOut : signale un nom rogne. Le JS comptait les APPELS (un nom long
// ecrit a cinq endroits comptait cinq fois) ; ici on compte les CORPS.
static std::string stepStr(const std::string& utf8, size_t max = 200, bool* cutOut = nullptr) {
    const std::vector<uint16_t> s = utf8ToUtf16(utf8);
    std::string out, buf; bool cut = false;
    static const char* H = "0123456789ABCDEF";
    auto flush = [&]() { if (!buf.empty()) { out += "\\X2\\"; out += buf; out += "\\X0\\"; buf.clear(); } };
    for (uint16_t c : s) {
        const bool ascii = (c >= 32 && c <= 126);
        const size_t len = ascii ? out.size() + (buf.empty() ? 0 : buf.size() + 8) + ((c == 39 || c == 92) ? 2 : 1)
                                 : out.size() + buf.size() + 4 + 8;
        if (len > max) { cut = true; break; }
        if (c == 39) { flush(); out += "''"; }
        else if (c == 92) { flush(); out += "\\\\"; }
        else if (ascii) { flush(); out += (char)c; }
        else { buf += H[(c >> 12) & 15]; buf += H[(c >> 8) & 15]; buf += H[(c >> 4) & 15]; buf += H[c & 15]; }
    }
    if (cut && buf.size() >= 4) {
        const unsigned last = (unsigned)std::stoul(buf.substr(buf.size() - 4), nullptr, 16);
        if (last >= 0xD800 && last <= 0xDBFF) buf.resize(buf.size() - 4);
    }
    flush();
    if (cutOut) *cutOut = cut;
    return out;
}
static std::string stepStrA(const char* s) { return stepStr(std::string(s ? s : "")); }

// Ecrit '#id = <texte>;' replie a 72 colonnes apres une virgule HORS chaine —
// portage de _stepFold (la ligne suite commence par deux espaces).
static void emitLine(std::string& out, uint64_t id, const std::string& text) {
    const size_t st = out.size();
    out += '#'; appendU(out, id); out += " = ";
    size_t cur = out.size() - st;
    if (cur + text.size() + 1 <= 72) { out += text; out += ";\n"; return; }  // cas courant : pas de repli
    bool q = false;
    for (char c : text) {
        out += c; cur++;
        if (c == '\'') q = !q;
        if (!q && c == ',' && cur >= 72) { out += "\n  "; cur = 2; }
    }
    out += ";\n";
}

// ── Table de hachage dense (cle -> index d'insertion) ─────────────────────
// Adressage ouvert, puissance de 2 ; l'index rendu est le rang d'insertion,
// ce qui donne gratuitement des ids de sommets/aretes/plans contigus.
static inline uint64_t mix64(uint64_t x) {
    x += 0x9E3779B97F4A7C15ull; x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBull; return x ^ (x >> 31);
}
template <class K, class Hash>
struct DenseSet {
    std::vector<K> items; std::vector<uint32_t> slots; size_t mask = 0; Hash h;
    void reserve(size_t n) {
        size_t cap = 16; while (cap < n * 2) cap <<= 1;
        slots.assign(cap, kNone); mask = cap - 1; items.reserve(n);
    }
    void grow() {
        const size_t cap = slots.empty() ? 16 : slots.size() * 2;
        slots.assign(cap, kNone); mask = cap - 1;
        for (uint32_t j = 0; j < (uint32_t)items.size(); j++) {
            size_t i = h(items[j]) & mask;
            while (slots[i] != kNone) i = (i + 1) & mask;
            slots[i] = j;
        }
    }
    uint32_t intern(const K& k, bool& ins) {
        if (slots.empty() || (items.size() + 1) * 2 > slots.size()) grow();
        size_t i = h(k) & mask;
        for (;;) {
            const uint32_t s = slots[i];
            if (s == kNone) { slots[i] = (uint32_t)items.size(); items.push_back(k); ins = true; return slots[i]; }
            if (items[s] == k) { ins = false; return s; }
            i = (i + 1) & mask;
        }
    }
};
struct Q3 { int64_t x, y, z; bool operator==(const Q3& o) const { return x == o.x && y == o.y && z == o.z; } };
struct Q3Hash { size_t operator()(const Q3& k) const {
    return (size_t)mix64((uint64_t)k.x ^ mix64((uint64_t)k.y ^ mix64((uint64_t)k.z))); } };
struct PK { int64_t a, b, c, d; int32_t m;
    bool operator==(const PK& o) const { return a == o.a && b == o.b && c == o.c && d == o.d && m == o.m; } };
struct PKHash { size_t operator()(const PK& k) const {
    return (size_t)mix64((uint64_t)k.a ^ mix64((uint64_t)k.b ^ mix64((uint64_t)k.c
                         ^ mix64((uint64_t)k.d ^ mix64((uint64_t)(uint32_t)k.m))))); } };
struct U64Hash { size_t operator()(uint64_t k) const { return (size_t)mix64(k); } };

// ── Entree ─────────────────────────────────────────────────────────────────
struct Style { uint32_t rgb = 0xCCCCCC; double a = 1.0; };
struct Body {
    std::string name;
    uint32_t kind = 0;
    Style base;
    std::vector<Style> pal;
    double sc[3] = {0, 0, 0}, sr = 0;
    size_t posOff = 0, idxOff = 0, matOff = 0;  // offsets dans le corps de requete
    uint32_t nVert = 0, nTri = 0, flags = 0;
    // kind 2 : corps importe dont MEDUSA garde le B-Rep exact (cf. ImportEntry).
    // xf = matrice 3x4 (lignes) repere du FICHIER importe (mm, Z-up) -> repere
    // de SORTIE STEP ; xflags bit0 = recolore par l'utilisateur (les couleurs
    // de faces d'origine ne s'appliquent plus). Le maillage suit quand meme :
    // c'est le repli si la reference n'est plus dans le cache.
    std::string ref;
    double xf[12] = {1,0,0,0, 0,1,0,0, 0,0,1,0};
    uint32_t xflags = 0;
};
struct Request {
    int ap = 2, mode = 1, keyDec = 6;
    double tol = 1e-5;
    uint32_t objCount = 0;
    std::string version;
    std::vector<Body> bodies;
};

static Request parseRequest(const std::string& b) {
    size_t off = 0;
    auto need = [&](size_t n) {
        if (off + n > b.size() || off + n < off) throw std::runtime_error("/stepexport: truncated request");
    };
    auto u32 = [&]() { need(4); uint32_t v; std::memcpy(&v, b.data() + off, 4); off += 4; return v; };
    auto f64 = [&]() { need(8); double v; std::memcpy(&v, b.data() + off, 8); off += 8; return v; };
    auto str = [&]() {
        const uint32_t n = u32(); const size_t padded = ((size_t)n + 3) & ~(size_t)3;
        need(padded); std::string s(b.data() + off, n); off += padded; return s;
    };
    need(4);
    if (std::memcmp(b.data(), "NSX1", 4) != 0) throw std::runtime_error("/stepexport: bad magic (expected NSX1)");
    off = 4;
    Request r;
    r.ap = (int)u32(); r.mode = (int)u32(); r.keyDec = (int)u32(); r.tol = f64();
    if (r.ap < 0 || r.ap > 2) throw std::runtime_error("/stepexport: unknown AP code");
    if (r.mode < 0 || r.mode > 2) throw std::runtime_error("/stepexport: unknown fusion mode");
    r.keyDec = std::max(1, std::min(9, r.keyDec));
    if (!(r.tol > 0) || !std::isfinite(r.tol)) r.tol = 1e-5;
    r.objCount = u32();
    r.version = str();
    const uint32_t n = u32();
    if ((size_t)n > b.size() / 16) throw std::runtime_error("/stepexport: bodyCount inconsistent with request size");
    r.bodies.resize(n);
    for (uint32_t i = 0; i < n; i++) {
        Body& bd = r.bodies[i];
        bd.kind = u32();
        bd.name = str();
        bd.base.rgb = u32() & 0xFFFFFFu; bd.base.a = f64();
        const uint32_t np = u32();
        if ((size_t)np > (b.size() - off) / 12) throw std::runtime_error("/stepexport: palette size inconsistent");
        bd.pal.resize(np);
        for (auto& p : bd.pal) { p.rgb = u32() & 0xFFFFFFu; p.a = f64(); }
        if (bd.kind == 2) {
            bd.ref = str();
            for (double& v : bd.xf) v = f64();
            bd.xflags = u32();
        }
        if (bd.kind == 1) {
            bd.sc[0] = f64(); bd.sc[1] = f64(); bd.sc[2] = f64(); bd.sr = f64();
        } else if (bd.kind == 0 || bd.kind == 2) {
            bd.nVert = u32(); bd.nTri = u32(); bd.flags = u32();
            const bool indexed = (bd.flags & 1u) != 0, hasMat = (bd.flags & 2u) != 0;
            if (!indexed && (uint64_t)bd.nVert != (uint64_t)bd.nTri * 3)
                throw std::runtime_error("/stepexport: triangle soup must have nVert = 3*nTri");
            bd.posOff = off; need((size_t)bd.nVert * 12); off += (size_t)bd.nVert * 12;
            if (indexed) { bd.idxOff = off; need((size_t)bd.nTri * 12); off += (size_t)bd.nTri * 12; }
            if (hasMat)  { bd.matOff = off; need((size_t)bd.nTri * 4);  off += (size_t)bd.nTri * 4; }
        } else throw std::runtime_error("/stepexport: unknown body kind");
    }
    return r;
}

// ── Plan d'un corps ────────────────────────────────────────────────────────
struct V3 { double x, y, z; };
enum PlanType { PT_EMPTY = 0, PT_MANIFOLD, PT_FACETED, PT_SPHERE, PT_TESS, PT_EXACT };
struct MFace { double n[3]; int32_t m; uint32_t loopBeg, loopEnd; uint64_t start, count; };
// Facettes : chaque triangle pointe sur un plan PARTAGE (triangles coplanaires).
struct FTri { uint32_t a, b, c, plane; int32_t m; };
struct FPlane { uint32_t pt; double n[3]; };   // origine = un sommet deja ecrit
// Tessele AP242 : une TRIANGULATED_FACE par materiau. pn vide = les indices
// des triangles visent directement la COORDINATES_LIST (ISO 10303-42, pnindex
// LIST[0:?]) ; sinon triangles indexes dans pn (corps multicolores).
struct TGroup { int32_t m; std::vector<uint32_t> pn; std::vector<uint32_t> tri; };
struct Plan {
    PlanType type = PT_EMPTY;
    bool open = false;
    uint32_t inTris = 0;
    std::vector<V3> verts;                      // manifold : sommets de boucles ; facettes : points
    std::vector<std::pair<uint32_t,uint32_t>> edges;   // manifold : aretes (sens du 1er passage)
    std::vector<MFace> faces;
    std::vector<std::pair<uint32_t,uint32_t>> loops;   // [beg,end) dans oe
    std::vector<uint32_t> oe;                   // (arete << 1) | inverse
    uint64_t faceBlock = 0;                     // entites du bloc faces (manifold)
    std::vector<FTri> ftris;
    std::vector<FPlane> fplanes;
    std::vector<TGroup> tgroups;
    // PT_EXACT (prototype ecrit par OCCT) : entites de la fermeture des items,
    // sur une ligne, references OCCT d'origine ; xremap : ancien #id -> rang.
    std::vector<std::string> xent;
    std::vector<uint32_t> xremap;
    std::vector<uint32_t> xitems;               // rangs des items de representation
    std::string xrep;                           // type de representation choisi par OCCT
    std::vector<std::pair<uint32_t, FaceRGB>> xfaces;   // rang de face -> couleur d'origine
    V3 sc{0, 0, 0}; double sr = 0;
    uint64_t count = 0;                         // entites ecrites par ce corps
    uint64_t base = 0;                          // premier #id (apres somme prefixe)
    uint64_t brepId() const { return type == PT_EXACT ? base + xitems[0] : base + count - 1; }
};

// Y-up Three -> Z-up STEP : cv(x,y,z) = [x,-z,y]
static inline V3 cv(double x, double y, double z) { return V3{x, -z, y}; }

struct Ctx {
    const std::string* body = nullptr;
    int ap = 2; int mode = 1; int keyDec = 6; double scale = 1e6;
};
static inline int64_t qz(double v, double scale) {
    const double s = v * scale;
    if (!(std::fabs(s) < 9.0e18)) return s > 0 ? INT64_MAX : INT64_MIN;
    return (int64_t)std::llround(s);
}

struct TriIn { uint32_t v[3]; double n[3]; double k[3]; int32_t m; };

// Merge coplanaire — portage de _planarMerge. Rend false si le corps doit
// partir en facettes (topologie ambigue, coque non fermee, < 4 faces).
static bool planarMerge(const std::vector<TriIn>& T, const std::vector<V3>& vpos,
                        double scale, Plan& P) {
    const size_t nT = T.size();
    if (!nT) return false;
    // 1) Groupes par plan (normale quantifiee, distance, materiau), dans
    //    l'ordre de premiere apparition — celui de la Map JS.
    DenseSet<PK, PKHash> groups; groups.reserve(nT / 4 + 16);
    std::vector<uint32_t> tg(nT);
    for (size_t i = 0; i < nT; i++) {
        const TriIn& t = T[i];
        const V3& A = vpos[t.v[0]];
        const double d = t.n[0] * A.x + t.n[1] * A.y + t.n[2] * A.z;
        bool ins;
        tg[i] = groups.intern(PK{qz(t.n[0], scale), qz(t.n[1], scale), qz(t.n[2], scale), qz(d, scale), t.m}, ins);
    }
    // NB : le JS prenait A = premier sommet BRUT du triangle ; ici c'est le
    // sommet soude. Meme tolerance de quantification, meme regroupement.
    const uint32_t nG = (uint32_t)groups.items.size();
    std::vector<uint32_t> gStart(nG + 1, 0), gList(nT);
    for (size_t i = 0; i < nT; i++) gStart[tg[i] + 1]++;
    for (uint32_t g = 0; g < nG; g++) gStart[g + 1] += gStart[g];
    { std::vector<uint32_t> fill(gStart.begin(), gStart.end() - 1);
      for (size_t i = 0; i < nT; i++) gList[fill[tg[i]]++] = (uint32_t)i; }

    // 2) Demi-aretes triees : (u<<32|v) -> triangle. Voisin = meme groupe et
    //    arete inverse ; bord = aucune arete inverse dans le groupe.
    struct HE { uint64_t k; uint32_t t; };
    std::vector<HE> he(nT * 3);
    for (size_t i = 0; i < nT; i++)
        for (int e = 0; e < 3; e++)
            he[i * 3 + e] = HE{((uint64_t)T[i].v[e] << 32) | T[i].v[(e + 1) % 3], (uint32_t)i};
    std::sort(he.begin(), he.end(), [](const HE& a, const HE& b) { return a.k < b.k || (a.k == b.k && a.t < b.t); });
    auto range = [&](uint64_t k) {
        auto lo = std::lower_bound(he.begin(), he.end(), k, [](const HE& a, uint64_t x) { return a.k < x; });
        auto hi = lo; while (hi != he.end() && hi->k == k) ++hi;
        return std::make_pair(lo, hi);
    };

    // 3) Composantes connexes par groupe, boucles de bord.
    std::vector<uint8_t> seen(nT, 0);
    std::vector<uint32_t> nextOf(vpos.size(), kNone), vstamp(vpos.size(), 0);
    uint32_t stamp = 0;
    std::vector<uint32_t> comp, stk, bndU, bndV, touched;
    std::vector<std::vector<uint32_t>> rawLoops;   // boucles (ids de sommets soudes)
    struct RawFace { double n[3]; int32_t m; std::vector<uint32_t> loopIdx; };
    std::vector<RawFace> rf;
    for (uint32_t g = 0; g < nG; g++) {
        for (uint32_t gi = gStart[g]; gi < gStart[g + 1]; gi++) {
            const uint32_t s0 = gList[gi];
            if (seen[s0]) continue;
            comp.clear(); stk.clear(); stk.push_back(s0); seen[s0] = 1;
            while (!stk.empty()) {
                const uint32_t c = stk.back(); stk.pop_back(); comp.push_back(c);
                for (int e = 0; e < 3; e++) {
                    const uint64_t rk = ((uint64_t)T[c].v[(e + 1) % 3] << 32) | T[c].v[e];
                    auto r = range(rk);
                    for (auto it = r.first; it != r.second; ++it)
                        if (tg[it->t] == g && !seen[it->t]) { seen[it->t] = 1; stk.push_back(it->t); }
                }
            }
            bndU.clear(); bndV.clear();
            for (uint32_t c : comp)
                for (int e = 0; e < 3; e++) {
                    const uint32_t u = T[c].v[e], v = T[c].v[(e + 1) % 3];
                    auto r = range(((uint64_t)v << 32) | u);
                    bool inv = false;
                    for (auto it = r.first; it != r.second; ++it) if (tg[it->t] == g) { inv = true; break; }
                    if (!inv) { bndU.push_back(u); bndV.push_back(v); }
                }
            if (bndU.empty()) return false;
            // chainage
            touched.clear();
            bool ok = true;
            for (size_t k = 0; k < bndU.size(); k++) {
                if (nextOf[bndU[k]] != kNone) { ok = false; break; }   // pincement -> ambigu
                nextOf[bndU[k]] = bndV[k]; touched.push_back(bndU[k]);
            }
            std::vector<std::vector<uint32_t>> loops;
            if (ok) {
                stamp++;
                for (size_t k = 0; k < bndU.size() && ok; k++) {
                    const uint32_t st = bndU[k];
                    if (vstamp[st] == stamp) continue;
                    std::vector<uint32_t> L{st}; vstamp[st] = stamp;
                    uint32_t cur = st;
                    for (;;) {
                        const uint32_t nx = nextOf[cur];
                        if (nx == kNone) { ok = false; break; }         // chaine cassee
                        if (nx == st) break;                            // boucle fermee
                        if (vstamp[nx] == stamp) { ok = false; break; } // collision
                        L.push_back(nx); vstamp[nx] = stamp; cur = nx;
                    }
                    if (ok) loops.push_back(std::move(L));
                }
            }
            for (uint32_t u : touched) nextOf[u] = kNone;
            if (!ok) return false;
            // outer / trous : aire 2D projetee dans le plan du 1er triangle
            const double* nr = T[comp[0]].n;
            const double arb[3] = { std::fabs(nr[0]) < 0.9 ? 1.0 : 0.0, std::fabs(nr[0]) < 0.9 ? 0.0 : 1.0, 0.0 };
            auto crs = [](const double* a, const double* b, double* o) {
                o[0] = a[1]*b[2]-a[2]*b[1]; o[1] = a[2]*b[0]-a[0]*b[2]; o[2] = a[0]*b[1]-a[1]*b[0]; };
            auto nrmz = [](double* a) { double l = std::sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); if (l == 0) l = 1; a[0]/=l; a[1]/=l; a[2]/=l; };
            double uA[3], vA[3]; crs(arb, nr, uA); nrmz(uA); crs(nr, uA, vA); nrmz(vA);
            std::vector<std::pair<double,size_t>> area(loops.size());
            for (size_t li = 0; li < loops.size(); li++) {
                const auto& L = loops[li]; double a = 0;
                const size_t n = L.size();
                for (size_t i = 0; i < n; i++) {
                    const V3& p = vpos[L[i]]; const V3& q = vpos[L[(i + 1) % n]];
                    const double x1 = p.x*uA[0]+p.y*uA[1]+p.z*uA[2], y1 = p.x*vA[0]+p.y*vA[1]+p.z*vA[2];
                    const double x2 = q.x*uA[0]+q.y*uA[1]+q.z*uA[2], y2 = q.x*vA[0]+q.y*vA[1]+q.z*vA[2];
                    a += x1 * y2 - x2 * y1;
                }
                area[li] = {std::fabs(a / 2), li};
            }
            std::stable_sort(area.begin(), area.end(), [](const std::pair<double,size_t>& a, const std::pair<double,size_t>& b) { return a.first > b.first; });
            RawFace f; f.n[0] = nr[0]; f.n[1] = nr[1]; f.n[2] = nr[2]; f.m = T[comp[0]].m;
            for (auto& ar : area) { f.loopIdx.push_back((uint32_t)rawLoops.size()); rawLoops.push_back(std::move(loops[ar.second])); }
            rf.push_back(std::move(f));
        }
    }
    if (rf.size() < 4) return false;

    // 4) Aretes : dedoublonnage non oriente, sens du premier passage (mkEdge),
    //    validation « chaque arete dans exactement deux boucles » (CLOSED_SHELL).
    DenseSet<uint64_t, U64Hash> eset; eset.reserve(rawLoops.size() * 4 + 16);
    std::vector<uint32_t> ecount;
    std::vector<uint32_t> vRemap(vpos.size(), kNone);
    P.verts.clear(); P.edges.clear(); P.oe.clear(); P.loops.clear(); P.faces.clear();
    auto vid = [&](uint32_t v) {
        if (vRemap[v] == kNone) { vRemap[v] = (uint32_t)P.verts.size(); P.verts.push_back(vpos[v]); }
        return vRemap[v];
    };
    uint64_t fcur = 0;
    for (const RawFace& f : rf) {
        MFace mf; mf.n[0] = f.n[0]; mf.n[1] = f.n[1]; mf.n[2] = f.n[2]; mf.m = f.m;
        mf.loopBeg = (uint32_t)P.loops.size();
        uint64_t cnt = 6;
        for (uint32_t li : f.loopIdx) {
            const auto& L = rawLoops[li];
            const uint32_t beg = (uint32_t)P.oe.size();
            const size_t n = L.size();
            for (size_t i = 0; i < n; i++) {
                const uint32_t a = vid(L[i]), b = vid(L[(i + 1) % n]);
                const uint64_t key = a < b ? (((uint64_t)a << 32) | b) : (((uint64_t)b << 32) | a);
                bool ins; const uint32_t e = eset.intern(key, ins);
                if (ins) { P.edges.push_back({a, b}); ecount.push_back(0); }
                ecount[e]++;
                P.oe.push_back((e << 1) | (P.edges[e].first == a ? 0u : 1u));
            }
            P.loops.push_back({beg, (uint32_t)P.oe.size()});
            cnt += n + 2;                      // ORIENTED_EDGE x n + EDGE_LOOP + bound
        }
        mf.loopEnd = (uint32_t)P.loops.size();
        mf.start = fcur; mf.count = cnt; fcur += cnt;
        P.faces.push_back(mf);
    }
    for (uint32_t c : ecount) if (c != 2) return false;
    if (P.edges.size() > 0x7FFFFFFFu) return false;
    P.faceBlock = fcur;
    P.type = PT_MANIFOLD;
    P.count = (uint64_t)P.verts.size() * 2 + (uint64_t)P.edges.size() * 4 + fcur + 2;
    return true;
}

// Remet a zero la topologie d'un merge refuse a mi-chemin.
static void clearMerge(Plan& P) {
    P.edges.clear(); P.faces.clear(); P.loops.clear(); P.oe.clear();
    P.edges.shrink_to_fit(); P.faces.shrink_to_fit(); P.loops.shrink_to_fit(); P.oe.shrink_to_fit();
}
// Coque fermee <=> chaque arete non orientee est partagee par exactement deux triangles.
static bool isClosedMesh(const std::vector<TriIn>& T) {
    DenseSet<uint64_t, U64Hash> par; par.reserve(T.size() * 2 + 16);
    std::vector<uint32_t> pc;
    auto bump = [&](uint32_t a, uint32_t b) {
        const uint64_t k = a < b ? (((uint64_t)a << 32) | b) : (((uint64_t)b << 32) | a);
        bool ins; const uint32_t i = par.intern(k, ins); if (ins) pc.push_back(0); pc[i]++;
    };
    for (const TriIn& t : T) { bump(t.v[0], t.v[1]); bump(t.v[1], t.v[2]); bump(t.v[2], t.v[0]); }
    for (uint32_t c : pc) if (c != 2) return false;
    return true;
}
// Nombre de plans distincts (normale + distance quantifiees, sans materiau).
// Sert a l'estimation de taille AVANT de lancer le merge.
static size_t countPlanes(const std::vector<TriIn>& T, const std::vector<V3>& vpos, double scale) {
    DenseSet<PK, PKHash> pl; pl.reserve(T.size() / 2 + 16);
    for (const TriIn& t : T) {
        const V3& A = vpos[t.v[0]];
        const double d = t.n[0] * A.x + t.n[1] * A.y + t.n[2] * A.z;
        bool ins; pl.intern(PK{qz(t.n[0], scale), qz(t.n[1], scale), qz(t.n[2], scale), qz(d, scale), 0}, ins);
    }
    return pl.items.size();
}

// [24/09 — Nass : « 357 Mo a l'import, 2,2 Go a l'export »] FACETED_BREP
// COMPACT (AP203 / AP214). Le writer d'origine ecrivait 8 entites par
// triangle, dont un plan complet (point, deux directions, repere) propre a
// chaque triangle. Ici, dans ce que la norme permet :
//   - un PLANE par plan DISTINCT, partage par tous les triangles coplanaires
//     (face_geometry est une reference : rien n'interdit le partage) ;
//   - l'origine du repere reutilise un sommet deja ecrit ;
//   - ref_direction, OPTIONAL dans AXIS2_PLACEMENT_3D, est omise ($).
// Reste par triangle : POLY_LOOP, FACE_OUTER_BOUND, FACE_SURFACE — 3 entites.
static void planFaceted(const std::vector<TriIn>& T, const std::vector<V3>& vpos, double scale, Plan& P) {
    clearMerge(P);
    P.type = PT_FACETED; P.verts.clear(); P.ftris.clear(); P.fplanes.clear(); P.ftris.reserve(T.size());
    std::vector<uint32_t> remap(vpos.size(), kNone);
    auto pid = [&](uint32_t v) {
        if (remap[v] == kNone) { remap[v] = (uint32_t)P.verts.size(); P.verts.push_back(vpos[v]); }
        return remap[v];
    };
    DenseSet<PK, PKHash> pl; pl.reserve(T.size() / 2 + 16);
    for (const TriIn& t : T) {
        FTri f; f.a = pid(t.v[0]); f.b = pid(t.v[1]); f.c = pid(t.v[2]); f.m = t.m;
        const V3& A = vpos[t.v[0]];
        const double d = t.n[0] * A.x + t.n[1] * A.y + t.n[2] * A.z;
        bool ins;
        f.plane = pl.intern(PK{qz(t.n[0], scale), qz(t.n[1], scale), qz(t.n[2], scale), qz(d, scale), 0}, ins);
        if (ins) P.fplanes.push_back(FPlane{f.a, {t.n[0], t.n[1], t.n[2]}});
        P.ftris.push_back(f);
    }
    P.open = !isClosedMesh(T);
    P.count = (uint64_t)P.verts.size() + 3 * (uint64_t)P.fplanes.size() + 3 * (uint64_t)P.ftris.size() + 2;
}

// [24/09] TESSELE AP242 — l'etat de l'art pour un maillage (ISO 10303-42
// ed.4, AP242 ed.2 ; CAx-IF « Recommended Practices for 3D Tessellated
// Geometry ») : un COORDINATES_LIST par corps, une TRIANGULATED_FACE par
// materiau, le tout dans un TESSELLATED_SOLID (coque fermee) ou un
// TESSELLATED_SHELL (ouverte), porte par une TESSELLATED_SHAPE_REPRESENTATION.
// ~50 octets par triangle au lieu de ~850 pour un triangle en ADVANCED_FACE.
// Normales non ecrites (liste vide, autorisee) : tout lecteur les recalcule,
// et elles doubleraient la taille des coordonnees.
static void planTess(const std::vector<TriIn>& T, const std::vector<V3>& vpos, Plan& P) {
    clearMerge(P);
    P.type = PT_TESS; P.verts.clear(); P.tgroups.clear();
    std::vector<uint32_t> remap(vpos.size(), kNone);
    auto pid = [&](uint32_t v) {
        if (remap[v] == kNone) { remap[v] = (uint32_t)P.verts.size(); P.verts.push_back(vpos[v]); }
        return remap[v];
    };
    // Groupes par materiau, dans l'ordre d'apparition.
    std::vector<int32_t> mats;
    for (const TriIn& t : T) if (std::find(mats.begin(), mats.end(), t.m) == mats.end()) {
        mats.push_back(t.m);
        if (mats.size() > 4096) break;                   // garde-fou : palette absurde
    }
    if (mats.size() > 4096) mats.assign(1, T[0].m);      // -> une seule face, couleur de corps
    P.tgroups.resize(mats.size());
    for (size_t g = 0; g < mats.size(); g++) P.tgroups[g].m = mats[g];
    const bool single = mats.size() == 1;
    std::vector<uint32_t> local;                          // pour pn : global -> local, par groupe
    for (size_t g = 0; g < mats.size(); g++) {
        TGroup& G = P.tgroups[g];
        if (!single) local.assign(vpos.size(), kNone);
        for (const TriIn& t : T) {
            if (!single && t.m != G.m) continue;
            for (int k = 0; k < 3; k++) {
                const uint32_t gv = pid(t.v[k]);
                if (single) { G.tri.push_back(gv); continue; }
                uint32_t& l = local[t.v[k]];
                if (l == kNone) { l = (uint32_t)G.pn.size(); G.pn.push_back(gv); }
                G.tri.push_back(l);
            }
        }
    }
    P.open = !isClosedMesh(T);
    P.count = 2 + (uint64_t)P.tgroups.size();
}
// Estimations de taille (octets), mesurees sur les sorties reelles : elles ne
// servent qu'a CHOISIR la representation d'un corps, pas a allouer.
static inline double estManifold(const Plan& P) { return 47.0 * (double)P.count; }
static inline double estTess(size_t nV, size_t nT) { return 300.0 + 34.0 * (double)nV + 24.0 * (double)nT; }
static inline double estFaceted(size_t nV, size_t nPl, size_t nT) { return 65.0 * (double)nV + 135.0 * (double)nPl + 130.0 * (double)nT; }

static void planBody(const Body& bd, const Ctx& cx, Plan& P) {
    if (bd.kind == 1) {
        P.type = PT_SPHERE; P.sc = cv(bd.sc[0], bd.sc[1], bd.sc[2]); P.sr = bd.sr; P.count = 22;
        return;
    }
    P.inTris = bd.nTri;
    if (!bd.nTri) return;
    const char* raw = cx.body->data();
    std::vector<float> pos((size_t)bd.nVert * 3);
    std::memcpy(pos.data(), raw + bd.posOff, pos.size() * 4);
    std::vector<uint32_t> idx;
    if (bd.flags & 1u) {
        idx.resize((size_t)bd.nTri * 3);
        std::memcpy(idx.data(), raw + bd.idxOff, idx.size() * 4);
        for (uint32_t v : idx) if (v >= bd.nVert) throw std::runtime_error("/stepexport: index out of range in body '" + bd.name + "'");
    }
    std::vector<int32_t> mat;
    if (bd.flags & 2u) { mat.resize(bd.nTri); std::memcpy(mat.data(), raw + bd.matOff, mat.size() * 4); }

    // Soudure quantifiee (cle JS : toFixed(keyDec) par composante). Le sommet
    // garde les coordonnees de sa premiere occurrence, comme mkVtx/mkPt.
    DenseSet<Q3, Q3Hash> vset; vset.reserve(std::min<size_t>((size_t)bd.nVert, (size_t)bd.nTri * 3) + 16);
    std::vector<V3> vpos; vpos.reserve(vset.items.capacity());
    std::vector<uint32_t> weld(bd.nVert, kNone);
    auto vtx = [&](uint32_t i) {
        if (weld[i] != kNone) return weld[i];
        const V3 p = cv(pos[(size_t)i*3], pos[(size_t)i*3+1], pos[(size_t)i*3+2]);
        bool ins; const uint32_t id = vset.intern(Q3{qz(p.x, cx.scale), qz(p.y, cx.scale), qz(p.z, cx.scale)}, ins);
        if (ins) vpos.push_back(p);
        weld[i] = id; return id;
    };
    std::vector<TriIn> T; T.reserve(bd.nTri);
    for (uint32_t t = 0; t < bd.nTri; t++) {
        const uint32_t ia = idx.empty() ? t*3 : idx[(size_t)t*3], ib = idx.empty() ? t*3+1 : idx[(size_t)t*3+1],
                       ic = idx.empty() ? t*3+2 : idx[(size_t)t*3+2];
        // normale depuis les coordonnees BRUTES (comme le JS), pas soudees
        const V3 A = cv(pos[(size_t)ia*3], pos[(size_t)ia*3+1], pos[(size_t)ia*3+2]);
        const V3 B = cv(pos[(size_t)ib*3], pos[(size_t)ib*3+1], pos[(size_t)ib*3+2]);
        const V3 C = cv(pos[(size_t)ic*3], pos[(size_t)ic*3+1], pos[(size_t)ic*3+2]);
        const double ex = B.x-A.x, ey = B.y-A.y, ez = B.z-A.z, gx = C.x-A.x, gy = C.y-A.y, gz = C.z-A.z;
        double nx = ey*gz-ez*gy, ny = ez*gx-ex*gz, nz = ex*gy-ey*gx;
        const double nl = std::sqrt(nx*nx+ny*ny+nz*nz);
        if (nl < 1e-10) continue;                                // degenere -> ignore (JS)
        TriIn ti; ti.v[0] = vtx(ia); ti.v[1] = vtx(ib); ti.v[2] = vtx(ic);
        if (ti.v[0] == ti.v[1] || ti.v[1] == ti.v[2] || ti.v[0] == ti.v[2]) continue;  // effondre a la soudure
        ti.n[0] = nx/nl; ti.n[1] = ny/nl; ti.n[2] = nz/nl;
        ti.k[0] = (A.x+B.x+C.x)/3; ti.k[1] = (A.y+B.y+C.y)/3; ti.k[2] = (A.z+B.z+C.z)/3;
        ti.m = mat.empty() ? -1 : mat[t];
        T.push_back(ti);
    }
    std::vector<float>().swap(pos); std::vector<uint32_t>().swap(idx); std::vector<uint32_t>().swap(weld);
    if (T.empty()) return;                                        // corps vide : aucun produit (JS)
    // ── Choix de la representation, corps par corps ──────────────────────
    // [24/09] L'ancienne regle « merge coplanaire, sinon facettes » ecrivait
    // tout triangle courbe en ADVANCED_FACE complete (~18 entites) : c'est ce
    // qui faisait passer un STEP de 357 Mo a 2,2 Go. Regle actuelle :
    //   - AP242 : maillage -> TESSELE (compact, fidele) ; le B-Rep a faces
    //     planes n'est garde que s'il reste proche en taille (pieces
    //     polyedriques : boites, profils, toles) — lui s'edite comme un solide
    //     dans SolidWorks/CATIA, le tessele n'y est qu'un corps graphique ;
    //   - AP203 / AP214 (pas d'entites tesselees dans ces schemas) : meme
    //     arbitrage face au FACETED_BREP compact ;
    //   - mode « Facets » : jamais de merge.
    // Seuil absolu : un petit corps garde toujours son B-Rep, l'ecart y est de
    // quelques Ko et le gain d'usage reel.
    const bool ap242 = cx.ap == 2;
    const size_t nPl = countPlanes(T, vpos, cx.scale);
    const double alt = ap242 ? estTess(vpos.size(), T.size()) : estFaceted(vpos.size(), nPl, T.size());
    const double kRatio = ap242 ? 8.0 : 2.0, kSmall = 16384.0;
    const double budget = std::max(kSmall, kRatio * alt);
    // Borne basse du B-Rep, sans le calculer : au moins ~11 entites par face
    // plane distincte (3 aretes orientees, boucle, bord, plan complet).
    const bool mergeWorthTrying = cx.mode != 2 && 47.0 * 11.0 * (double)nPl <= budget;
    if (mergeWorthTrying && planarMerge(T, vpos, cx.scale, P) && estManifold(P) <= budget) return;
    if (ap242) planTess(T, vpos, P);
    else       planFaceted(T, vpos, cx.scale, P);
}

// ═════════════════════════════════════════════════════════════════════════════
// [24/09] PROTOTYPES EXACTS — le B-Rep d'origine, reecrit par OCCT, instancie.
//
// Un prototype = une forme d'origine (TShape) + une echelle + un etat de
// couleur. Tous les corps qui la partagent (les 17 vis M3x6 d'un assemblage)
// n'en ecrivent qu'UNE copie ; chacun n'ajoute que son occurrence (NAUO +
// placement), exactement comme le fichier source. C'est ce qui ramene l'export
// a la taille — et a la precision — de l'original.
//
// OCCT (STEPControl_Writer) ecrit le prototype seul dans un modele jetable ; on
// n'en garde que la FERMETURE des items de sa representation (solide, faces,
// surfaces, courbes, points), renumerotee dans nos #id. Produit, contexte et
// unites d'OCCT sont ecartes : ce sont les notres qui portent l'assemblage.
// Pas de p-curves (write.surfacecurve.mode = 0) : le fichier source n'en a
// pas non plus, et tout lecteur les recalcule.
// Les ecritures de prototypes tournent en parallele — verifie : sortie
// identique a l'ecriture sequentielle, forme partagee entre threads comprise
// (seul un compteur de nom de produit OCCT differe, et ce produit est jete).
// ═════════════════════════════════════════════════════════════════════════════
struct Proto {
    TopoDS_Shape shape;                         // location identite, echelle deja appliquee
    std::shared_ptr<FaceColorMap> faceColors;   // cles = TShape des faces de `shape` ; nul = pas de couleur de face
    // Couleur AFFICHEE des faces sans style propre : la couleur de corps lue a
    // l'import (MeshData::faces la donne a ces faces). Le client, lui, prend
    // pour couleur de corps la teinte DOMINANTE des faces ; sans ceci, un corps
    // majoritairement stylé perdait la couleur de ses faces non stylées.
    bool hasUnstyled = false;
    FaceRGB unstyled{0, 0, 0, 1.0f};
    Style base;
    std::string name;
    bool ok = false;
};

// Matrice 3x4 (lignes) -> gp_Trsf. Refuse ce qu'un placement STEP ne sait pas
// dire : miroir (det <= 0), cisaillement, echelle non uniforme.
static bool makeTrsf(const double* m, gp_Trsf& T) {
    const double a[3][3] = {{m[0], m[1], m[2]}, {m[4], m[5], m[6]}, {m[8], m[9], m[10]}};
    const double det = a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1]) - a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])
                     + a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
    if (!(det > 1e-18) || !std::isfinite(det)) return false;
    const double s = std::cbrt(det), s2 = s * s;
    for (int i = 0; i < 3; i++) for (int j = i; j < 3; j++) {
        const double d = a[0][i]*a[0][j] + a[1][i]*a[1][j] + a[2][i]*a[2][j];
        if (std::fabs(d - (i == j ? s2 : 0.0)) > 1e-6 * s2) return false;
    }
    try { T.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]); }
    catch (...) { return false; }
    return true;
}

// Lecture de la section DATA d'un Part 21 ecrit par OCCT : ent[id] = texte de
// l'entite sur UNE ligne (sauts de ligne et indentation d'OCCT retires hors
// chaines ; dans une chaine, un saut de ligne n'est pas significatif).
static bool parseDataSection(const std::string& txt, std::vector<std::string>& ent) {
    size_t p = txt.find("\nDATA;");
    if (p == std::string::npos) return false;
    p += 6;
    const size_t n = txt.size();
    ent.clear();
    while (p < n) {
        while (p < n && (txt[p] == ' ' || txt[p] == '\n' || txt[p] == '\r' || txt[p] == '\t')) p++;
        if (p >= n || txt[p] != '#') break;                  // ENDSEC;
        p++;
        uint64_t id = 0;
        while (p < n && txt[p] >= '0' && txt[p] <= '9') id = id * 10 + (uint64_t)(txt[p++] - '0');
        while (p < n && (txt[p] == ' ' || txt[p] == '=')) p++;
        std::string t;
        bool q = false, nl = false;
        for (; p < n; p++) {
            const char c = txt[p];
            if (c == '\n' || c == '\r') { nl = !q; continue; }
            if (nl && (c == ' ' || c == '\t')) continue;
            nl = false;
            if (c == '\'') q = !q;
            if (!q && c == ';') { p++; break; }
            t += c;
        }
        if (id >= ent.size()) ent.resize(id + 1);
        ent[id] = std::move(t);
    }
    return !ent.empty();
}
// Parametres de premier niveau de « TYPE(p1,p2,...) ».
static std::vector<std::string> topParams(const std::string& e) {
    std::vector<std::string> out;
    const size_t o = e.find('(');
    if (o == std::string::npos) return out;
    int depth = 0; bool q = false; std::string cur;
    for (size_t i = o + 1; i < e.size(); i++) {
        const char c = e[i];
        if (c == '\'') q = !q;
        if (!q) {
            if (c == '(') depth++;
            else if (c == ')') { if (depth == 0) { out.push_back(cur); break; } depth--; }
            else if (c == ',' && depth == 0) { out.push_back(cur); cur.clear(); continue; }
        }
        cur += c;
    }
    return out;
}
template <class F> static void forEachRef(const std::string& e, F&& f) {
    bool q = false;
    for (size_t i = 0; i < e.size(); i++) {
        const char c = e[i];
        if (c == '\'') { q = !q; continue; }
        if (q || c != '#') continue;
        uint64_t r = 0; size_t j = i + 1;
        while (j < e.size() && e[j] >= '0' && e[j] <= '9') r = r * 10 + (uint64_t)(e[j++] - '0');
        if (j > i + 1) f(r);
        i = j - 1;
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// [24/09 — plantage de Nass, rapport medusa-crash du 24/09 17:36] B-SPLINES
// PERIODIQUES QUE L'ECRIVAIN STEP D'OCCT NE SAIT PAS OUVRIR.
//
// STEP n'a pas de B-spline periodique : GeomToStep (MakeBoundedCurve,
// MakeBoundedSurface, et Segment dans MakeCurve / MakeStepEdge) « ouvre » la
// courbe par SetNotPeriodic -> BSplCLib::PrepareUnperiodize / Unperiodize.
// Ces deux boucles remontent les multiplicites depuis chaque bout jusqu'a
// degre + 1 SANS borne : quand le noeud n'en porte pas assez, elles lisent
// hors du tableau (Mults(0), Mults(n+1)...).
//   - OCCT compile avec controles (paquets Linux) : Standard_OutOfRange, la
//     piece repart en maillage — rien de visible ;
//   - OCCT en Release sous Windows (No_Exception : aucun controle de bornes) :
//     multiplicites lues dans le tas, longueur de noeuds negative, tableau nul,
//     ECRITURE A L'ADRESSE 0 — MEDUSA meurt. Constate sur Cruise_Assembly :
//     arete de degre 3, 3 noeuds de multiplicite 1, 2 poles, periode 1,1e-5 mm
//     (TKMath!BSplCLib::KnotSequence <- Geom_BSplineCurve::SetNotPeriodic <-
//     GeomToStep_MakeBoundedCurve <- TopoDSToStep_MakeStepEdge).
// Le controle rejoue ces boucles AVEC leurs bornes, avant de confier la forme
// a OCCT : un prototype qui en porte une est ecrit depuis son maillage, comme
// n'importe quel echec d'OCCT. Lecture seule — sur des formes partagees entre
// threads, c'est la seule chose permise.
// ═════════════════════════════════════════════════════════════════════════════
static bool unperiodizeSafe(const NCollection_Array1<int>& M, const int deg) {
    if (M.Lower() != 1 || M.Length() < 2 || deg < 1) return false;   // Unperiodize indexe a partir de 1
    const int n = M.Length();
    for (int i = 1; i <= n; i++) if (M(i) < 1) return false;
    int sigma = M(1), k = n - 1;                                    // debut de la courbe
    while (sigma < deg + 1) { if (k < 1) return false; sigma += M(k); k--; }
    sigma = M(n); k = 2;                                            // fin de la courbe
    while (sigma < deg + 1) { if (k > n) return false; sigma += M(k); k++; }
    return true;
}
static bool curveWritable(const Handle(Geom_Curve)& c, const int depth = 0) {
    if (c.IsNull() || depth > 8) return true;
    Handle(Geom_TrimmedCurve) t = Handle(Geom_TrimmedCurve)::DownCast(c);
    if (!t.IsNull()) return curveWritable(t->BasisCurve(), depth + 1);
    Handle(Geom_OffsetCurve) o = Handle(Geom_OffsetCurve)::DownCast(c);
    if (!o.IsNull()) return curveWritable(o->BasisCurve(), depth + 1);
    Handle(Geom_BSplineCurve) b = Handle(Geom_BSplineCurve)::DownCast(c);
    if (b.IsNull() || !b->IsPeriodic()) return true;
    return b->Knots().Lower() == 1 && unperiodizeSafe(b->Multiplicities(), b->Degree());
}
static bool surfaceWritable(const Handle(Geom_Surface)& s, const int depth = 0) {
    if (s.IsNull() || depth > 8) return true;
    Handle(Geom_RectangularTrimmedSurface) t = Handle(Geom_RectangularTrimmedSurface)::DownCast(s);
    if (!t.IsNull()) return surfaceWritable(t->BasisSurface(), depth + 1);
    Handle(Geom_OffsetSurface) o = Handle(Geom_OffsetSurface)::DownCast(s);
    if (!o.IsNull()) return surfaceWritable(o->BasisSurface(), depth + 1);
    Handle(Geom_SweptSurface) w = Handle(Geom_SweptSurface)::DownCast(s);   // revolution, extrusion : leur courbe
    if (!w.IsNull()) return curveWritable(w->BasisCurve(), depth + 1);
    Handle(Geom_BSplineSurface) b = Handle(Geom_BSplineSurface)::DownCast(s);
    if (b.IsNull()) return true;
    if (b->IsUPeriodic() && !(b->UKnots().Lower() == 1 && unperiodizeSafe(b->UMultiplicities(), b->UDegree()))) return false;
    if (b->IsVPeriodic() && !(b->VKnots().Lower() == 1 && unperiodizeSafe(b->VMultiplicities(), b->VDegree()))) return false;
    return true;
}
static bool exactGeometrySafe(const TopoDS_Shape& sh) {
    TopTools_IndexedMapOfShape edges, faces;
    TopExp::MapShapes(sh, TopAbs_EDGE, edges);
    for (int i = 1; i <= edges.Extent(); i++) {
        TopLoc_Location L; double f = 0, l = 0;
        if (!curveWritable(BRep_Tool::Curve(TopoDS::Edge(edges(i)), L, f, l))) return false;
    }
    TopExp::MapShapes(sh, TopAbs_FACE, faces);
    for (int i = 1; i <= faces.Extent(); i++) {
        TopLoc_Location L;
        if (!surfaceWritable(BRep_Tool::Surface(TopoDS::Face(faces(i)), L))) return false;
    }
    return true;
}

static bool planExact(const Proto& pr, Plan& P) {
    STEPControl_Writer w;
#if OCC_VERSION_HEX >= 0x070800
    DESTEP_Parameters prm;
    prm.InitFromStatic();
    prm.WriteSurfaceCurMode = false;
    if (w.Transfer(pr.shape, STEPControl_AsIs, prm) != IFSelect_RetDone) return false;
#else
    {
        static std::once_flag once;
        std::call_once(once, [] { Interface_Static::SetIVal("write.surfacecurve.mode", 0); });
    }
    if (w.Transfer(pr.shape, STEPControl_AsIs) != IFSelect_RetDone) return false;
#endif
    // Faces a couleur d'origine -> leur entite (avant ecriture : la numerotation
    // du texte est celle du modele, Interface_InterfaceModel::Number).
    // Couleur affichee de chaque face (style propre, sinon couleur de corps lue
    // a l'import) ; seules celles qui s'ecartent de la couleur de corps ecrite
    // deviennent des OVER_RIDING_STYLED_ITEM.
    std::vector<std::pair<uint64_t, FaceRGB>> faceIds;
    if (pr.faceColors && !pr.faceColors->empty()) {
        Handle(Transfer_FinderProcess) FP = w.WS()->TransferWriter()->FinderProcess();
        Handle(StepData_StepModel) M = w.Model();
        auto q8 = [](float v) { return (uint32_t)std::lround(std::max(0.0f, std::min(1.0f, v)) * 255.0f); };
        for (TopExp_Explorer x(pr.shape, TopAbs_FACE); x.More(); x.Next()) {
            auto it = pr.faceColors->find(x.Current().TShape().get());
            FaceRGB c;
            if (it != pr.faceColors->end()) c = it->second;
            else if (pr.hasUnstyled) c = pr.unstyled;
            else continue;
            const uint32_t rgb = (q8(c.r) << 16) | (q8(c.g) << 8) | q8(c.b);
            if (rgb == pr.base.rgb && std::fabs(c.a - pr.base.a) <= 1e-3) continue;
            TopLoc_Location l;
            Handle(StepRepr_RepresentationItem) e = STEPConstruct::FindEntity(FP, x.Current(), l);
            if (!e.IsNull()) faceIds.push_back({(uint64_t)M->Number(e), c});
        }
    }
    std::string txt;
#if OCC_VERSION_HEX >= 0x070700
    {
        std::ostringstream os;
        if (w.WriteStream(os) != IFSelect_RetDone) return false;
        txt = os.str();
    }
#else
    {
        static std::atomic<uint64_t> seq{0};
        const std::string tmp = (std::filesystem::temp_directory_path() /
            ("nasscad_proto_" + sessionNonce() + "_" + std::to_string(seq.fetch_add(1)) + ".stp")).string();
        if (w.Write(tmp.c_str()) != IFSelect_RetDone) return false;
        std::ifstream f(tmp, std::ios::binary); std::ostringstream ss; ss << f.rdbuf(); txt = ss.str();
        f.close(); std::remove(tmp.c_str());
    }
#endif
    std::vector<std::string> ent;
    if (!parseDataSection(txt, ent)) return false;
    std::string().swap(txt);
    // Representation de la forme : celle que vise le SHAPE_DEFINITION_REPRESENTATION.
    uint64_t repId = 0;
    for (size_t i = 1; i < ent.size() && !repId; i++)
        if (ent[i].rfind("SHAPE_DEFINITION_REPRESENTATION(", 0) == 0) {
            std::vector<uint64_t> r; forEachRef(ent[i], [&](uint64_t x) { r.push_back(x); });
            if (r.size() == 2 && r[1] < ent.size()) repId = r[1];
        }
    if (!repId) return false;
    const std::string& repTxt = ent[repId];
    const size_t po = repTxt.find('(');
    if (po == std::string::npos || repTxt[0] == '(') return false;      // representation complexe : on ne devine pas
    P.xrep = repTxt.substr(0, po);
    const std::vector<std::string> prm2 = topParams(repTxt);
    if (prm2.size() < 3) return false;
    std::vector<uint64_t> items;
    forEachRef(prm2[1], [&](uint64_t x) {
        if (x < ent.size() && ent[x].rfind("AXIS2_PLACEMENT_3D(", 0) != 0) items.push_back(x);
    });
    if (items.empty()) return false;
    // Fermeture des items (DFS), ordre des #id d'origine conserve.
    std::vector<uint8_t> seen(ent.size(), 0);
    std::vector<uint64_t> stk(items.begin(), items.end());
    for (uint64_t x : items) seen[x] = 1;
    while (!stk.empty()) {
        const uint64_t x = stk.back(); stk.pop_back();
        bool bad = false;
        forEachRef(ent[x], [&](uint64_t r) {
            if (r >= ent.size() || ent[r].empty()) { bad = true; return; }
            if (!seen[r]) { seen[r] = 1; stk.push_back(r); }
        });
        if (bad) return false;
    }
    // [24/09] L'ecrivain d'OCCT avale ses propres exceptions face par face : une
    // face qu'il n'a pas su traduire MANQUE simplement a la coque ecrite, statut
    // « fait » et sans un mot (constate sur Cruise_Assembly avec l'OCCT Linux :
    // 4 faces ecrites sur 7). Une coque trouee n'est pas un export exact : les
    // faces ecrites doivent etre toutes celles de la forme, sinon maillage.
    {
        TopTools_IndexedMapOfShape fm;
        TopExp::MapShapes(pr.shape, TopAbs_FACE, fm);
        size_t nf = 0;
        for (size_t i = 1; i < ent.size(); i++)
            if (seen[i] && (ent[i].rfind("ADVANCED_FACE(", 0) == 0 || ent[i].rfind("FACE_SURFACE(", 0) == 0)) nf++;
        if (nf != (size_t)fm.Extent()) return false;
    }
    P.xremap.assign(ent.size(), kNone);
    P.xent.clear();
    for (size_t i = 1; i < ent.size(); i++)
        if (seen[i]) { P.xremap[i] = (uint32_t)P.xent.size(); P.xent.push_back(std::move(ent[i])); }
    // La fermeture ne doit rien viser hors d'elle-meme (contexte, produit) :
    // un item geometrique qui le ferait n'est pas transplantable.
    P.xitems.clear();
    for (uint64_t x : items) P.xitems.push_back(P.xremap[x]);
    P.xfaces.clear();
    for (auto& f : faceIds) if (f.first < P.xremap.size() && P.xremap[f.first] != kNone) P.xfaces.push_back({P.xremap[f.first], f.second});
    P.type = PT_EXACT;
    P.count = P.xent.size();
    return true;
}

// ── Ecriture des blocs geometriques ────────────────────────────────────────
enum BlockKind { BK_MVERT, BK_MEDGE, BK_MFACE, BK_MTAIL, BK_FPT, BK_FPLANE, BK_FTRI, BK_FTAIL, BK_SPHERE,
                 BK_TCOORD, BK_TPN, BK_TTRI, BK_TSOLID, BK_XENT };
// aux : numero de TRIANGULATED_FACE pour BK_TPN / BK_TTRI.
struct Task { uint32_t body; BlockKind kind; uint64_t i0, i1; uint32_t aux = 0; bool proto = false; };

static void writeTask(const Task& tk, const Plan& P, const Body& bd, std::string& out) {
    std::string t; t.reserve(160);
    auto f6 = [&](double v) { appendReal(t, v, 6); };
    auto pt3 = [&](const V3& p) { t += "('',("; f6(p.x); t += ','; f6(p.y); t += ','; f6(p.z); t += "))"; };
    auto dir3 = [&](double x, double y, double z) { t += "DIRECTION('',("; f6(x); t += ','; f6(y); t += ','; f6(z); t += "))"; };
    const uint64_t B = P.base;
    switch (tk.kind) {
    case BK_MVERT:
        for (uint64_t i = tk.i0; i < tk.i1; i++) {
            const uint64_t id = B + 2 * i;
            t.clear(); t += "CARTESIAN_POINT"; pt3(P.verts[i]); emitLine(out, id, t);
            t.clear(); t += "VERTEX_POINT('',"; appendRef(t, id); t += ')'; emitLine(out, id + 1, t);
        }
        break;
    case BK_MEDGE: {
        const uint64_t E0 = B + 2 * (uint64_t)P.verts.size();
        for (uint64_t j = tk.i0; j < tk.i1; j++) {
            const uint64_t id = E0 + 4 * j;
            const uint32_t a = P.edges[j].first, b = P.edges[j].second;
            const V3& pa = P.verts[a]; const V3& pb = P.verts[b];
            const double dx = pb.x-pa.x, dy = pb.y-pa.y, dz = pb.z-pa.z;
            double dl = std::sqrt(dx*dx+dy*dy+dz*dz); if (dl == 0) dl = 1;
            t.clear(); dir3(dx/dl, dy/dl, dz/dl); emitLine(out, id, t);
            t.clear(); t += "VECTOR('',"; appendRef(t, id); t += ",1.)"; emitLine(out, id + 1, t);
            t.clear(); t += "LINE('',"; appendRef(t, B + 2 * (uint64_t)a); t += ','; appendRef(t, id + 1); t += ')'; emitLine(out, id + 2, t);
            t.clear(); t += "EDGE_CURVE('',"; appendRef(t, B + 2 * (uint64_t)a + 1); t += ',';
            appendRef(t, B + 2 * (uint64_t)b + 1); t += ','; appendRef(t, id + 2); t += ",.T.)"; emitLine(out, id + 3, t);
        }
        break;
    }
    case BK_MFACE: {
        const uint64_t E0 = B + 2 * (uint64_t)P.verts.size();
        const uint64_t F0 = E0 + 4 * (uint64_t)P.edges.size();
        std::vector<uint64_t> bounds;
        for (uint64_t f = tk.i0; f < tk.i1; f++) {
            const MFace& fc = P.faces[f];
            uint64_t id = F0 + fc.start;
            bounds.clear();
            for (uint32_t li = fc.loopBeg; li < fc.loopEnd; li++) {
                const auto& L = P.loops[li];
                const uint64_t oe0 = id;
                for (uint32_t k = L.first; k < L.second; k++) {
                    const uint32_t e = P.oe[k] >> 1; const bool rev = (P.oe[k] & 1u) != 0;
                    t.clear(); t += "ORIENTED_EDGE('',*,*,"; appendRef(t, E0 + 4 * (uint64_t)e + 3);
                    t += rev ? ",.F.)" : ",.T.)"; emitLine(out, id++, t);
                }
                t.clear(); t += "EDGE_LOOP('',(";
                for (uint64_t k = oe0; k < id; k++) { if (k != oe0) t += ','; appendRef(t, k); }
                t += "))"; const uint64_t el = id; emitLine(out, id++, t);
                t.clear(); t += (li == fc.loopBeg) ? "FACE_OUTER_BOUND('',"  : "FACE_BOUND('',";
                appendRef(t, el); t += ",.T.)"; bounds.push_back(id); emitLine(out, id++, t);
            }
            // Plan : origine = 1er sommet de l'outer, reference = 1re arete
            // projetee orthogonalement a la normale (identique au JS).
            const auto& OL = P.loops[fc.loopBeg];
            auto vOf = [&](uint32_t k) { const uint32_t e = P.oe[k] >> 1; return (P.oe[k] & 1u) ? P.edges[e].second : P.edges[e].first; };
            const V3& p0 = P.verts[vOf(OL.first)];
            const V3& p1 = P.verts[vOf(OL.first + 1 < OL.second ? OL.first + 1 : OL.first)];
            const double nx = fc.n[0], ny = fc.n[1], nz = fc.n[2];
            double rx = p1.x-p0.x, ry = p1.y-p0.y, rz = p1.z-p0.z;
            const double dt = rx*nx+ry*ny+rz*nz; rx -= dt*nx; ry -= dt*ny; rz -= dt*nz;
            double rl = std::sqrt(rx*rx+ry*ry+rz*rz); if (rl == 0) rl = 1; rx /= rl; ry /= rl; rz /= rl;
            const uint64_t iCP = id;
            t.clear(); t += "CARTESIAN_POINT"; pt3(p0); emitLine(out, id++, t);
            t.clear(); dir3(nx, ny, nz); emitLine(out, id++, t);
            t.clear(); dir3(rx, ry, rz); emitLine(out, id++, t);
            t.clear(); t += "AXIS2_PLACEMENT_3D('',"; appendRef(t, iCP); t += ','; appendRef(t, iCP + 1); t += ',';
            appendRef(t, iCP + 2); t += ')'; emitLine(out, id++, t);
            t.clear(); t += "PLANE('',"; appendRef(t, iCP + 3); t += ')'; emitLine(out, id++, t);
            t.clear(); t += "ADVANCED_FACE('',(";
            for (size_t k = 0; k < bounds.size(); k++) { if (k) t += ','; appendRef(t, bounds[k]); }
            t += "),"; appendRef(t, iCP + 4); t += ",.T.)"; emitLine(out, id++, t);
        }
        break;
    }
    case BK_MTAIL: {
        const uint64_t F0 = B + 2 * (uint64_t)P.verts.size() + 4 * (uint64_t)P.edges.size();
        t.clear(); t += "CLOSED_SHELL('',(";
        for (size_t f = 0; f < P.faces.size(); f++) { if (f) t += ','; appendRef(t, F0 + P.faces[f].start + P.faces[f].count - 1); }
        t += "))"; emitLine(out, B + P.count - 2, t);
        t.clear(); t += "MANIFOLD_SOLID_BREP('"; t += stepStr(bd.name); t += "',"; appendRef(t, B + P.count - 2); t += ')';
        emitLine(out, B + P.count - 1, t);
        break;
    }
    // ── FACETED_BREP compact : points | plans partages | 3 entites/triangle ──
    case BK_FPT:
        for (uint64_t i = tk.i0; i < tk.i1; i++) { t.clear(); t += "CARTESIAN_POINT"; pt3(P.verts[i]); emitLine(out, B + i, t); }
        break;
    case BK_FPLANE: {
        const uint64_t P0 = B + (uint64_t)P.verts.size();
        for (uint64_t j = tk.i0; j < tk.i1; j++) {
            const FPlane& pl = P.fplanes[j];
            const uint64_t id = P0 + 3 * j;
            t.clear(); dir3(pl.n[0], pl.n[1], pl.n[2]); emitLine(out, id, t);
            t.clear(); t += "AXIS2_PLACEMENT_3D('',"; appendRef(t, B + pl.pt); t += ','; appendRef(t, id); t += ",$)";
            emitLine(out, id + 1, t);
            t.clear(); t += "PLANE('',"; appendRef(t, id + 1); t += ')'; emitLine(out, id + 2, t);
        }
        break;
    }
    case BK_FTRI: {
        const uint64_t P0 = B + (uint64_t)P.verts.size();
        const uint64_t T0 = P0 + 3 * (uint64_t)P.fplanes.size();
        for (uint64_t i = tk.i0; i < tk.i1; i++) {
            const FTri& f = P.ftris[i];
            const uint64_t id = T0 + 3 * i;
            t.clear(); t += "POLY_LOOP('',("; appendRef(t, B + f.a); t += ','; appendRef(t, B + f.b); t += ',';
            appendRef(t, B + f.c); t += "))"; emitLine(out, id, t);
            t.clear(); t += "FACE_OUTER_BOUND('',"; appendRef(t, id); t += ",.T.)"; emitLine(out, id + 1, t);
            t.clear(); t += "FACE_SURFACE('',("; appendRef(t, id + 1); t += "),"; appendRef(t, P0 + 3 * (uint64_t)f.plane + 2);
            t += ",.T.)"; emitLine(out, id + 2, t);
        }
        break;
    }
    case BK_FTAIL: {
        const uint64_t T0 = B + (uint64_t)P.verts.size() + 3 * (uint64_t)P.fplanes.size();
        t.clear(); t += P.open ? "OPEN_SHELL('',(" : "CLOSED_SHELL('',(";
        for (size_t i = 0; i < P.ftris.size(); i++) { if (i) t += ','; appendRef(t, T0 + 3 * i + 2); }
        t += "))"; emitLine(out, B + P.count - 2, t);
        t.clear();
        if (P.open) { t += "SHELL_BASED_SURFACE_MODEL('"; t += stepStr(bd.name); t += "',("; appendRef(t, B + P.count - 2); t += "))"; }
        else        { t += "FACETED_BREP('"; t += stepStr(bd.name); t += "',"; appendRef(t, B + P.count - 2); t += ')'; }
        emitLine(out, B + P.count - 1, t);
        break;
    }
    // ── TESSELE AP242 ─────────────────────────────────────────────────────
    // Une entite peut peser des dizaines de Mo (COORDINATES_LIST d'un corps de
    // plusieurs millions de sommets) : elle est donc ecrite en PLUSIEURS blocs
    // paralleles. Chaque element connait sa place (index global), donc son
    // separateur et ses sauts de ligne ne dependent que de lui : 3 points,
    // 16 indices ou 4 triangles par ligne, toujours < 256 colonnes.
    case BK_TCOORD: {
        const uint64_t n = P.verts.size();
        if (tk.i0 == 0) { out += '#'; appendU(out, B); out += " = COORDINATES_LIST('',"; appendU(out, n); out += ",("; }
        for (uint64_t k = tk.i0; k < tk.i1; k++) {
            out += (k == 0) ? "\n  " : (k % 3 == 0 ? ",\n  " : ",");
            const V3& p = P.verts[k];
            out += '('; appendReal(out, p.x, 6); out += ','; appendReal(out, p.y, 6); out += ','; appendReal(out, p.z, 6); out += ')';
        }
        if (tk.i1 == n) out += "));\n";
        break;
    }
    case BK_TPN: {
        const TGroup& G = P.tgroups[tk.aux];
        const uint64_t npn = G.pn.size();
        if (tk.i0 == 0) {
            out += '#'; appendU(out, B + 1 + tk.aux); out += " = TRIANGULATED_FACE('',"; appendRef(out, B); out += ',';
            appendU(out, npn ? npn : (uint64_t)P.verts.size()); out += ",(),$,(";
        }
        for (uint64_t k = tk.i0; k < tk.i1; k++) {
            out += (k == 0) ? "\n  " : (k % 16 == 0 ? ",\n  " : ",");
            appendU(out, (uint64_t)G.pn[k] + 1);
        }
        if (tk.i1 == npn) out += "),(";
        break;
    }
    case BK_TTRI: {
        const TGroup& G = P.tgroups[tk.aux];
        const uint64_t nt = G.tri.size() / 3;
        for (uint64_t k = tk.i0; k < tk.i1; k++) {
            out += (k == 0) ? "\n  " : (k % 4 == 0 ? ",\n  " : ",");
            out += '('; appendU(out, (uint64_t)G.tri[k*3] + 1); out += ',';
            appendU(out, (uint64_t)G.tri[k*3+1] + 1); out += ','; appendU(out, (uint64_t)G.tri[k*3+2] + 1); out += ')';
        }
        if (tk.i1 == nt) out += "));\n";
        break;
    }
    case BK_XENT: {
        // Entites OCCT renumerotees : ancien #id -> base + rang dans la fermeture.
        for (uint64_t k = tk.i0; k < tk.i1; k++) {
            const std::string& e = P.xent[k];
            t.clear();
            bool q = false;
            for (size_t i = 0; i < e.size(); i++) {
                const char c = e[i];
                if (c == '\'') q = !q;
                if (q || c != '#') { t += c; continue; }
                uint64_t r = 0; size_t j = i + 1;
                while (j < e.size() && e[j] >= '0' && e[j] <= '9') r = r * 10 + (uint64_t)(e[j++] - '0');
                appendRef(t, B + P.xremap[r]);
                i = j - 1;
            }
            emitLine(out, B + k, t);
        }
        break;
    }
    case BK_TSOLID: {
        t.clear(); t += P.open ? "TESSELLATED_SHELL('" : "TESSELLATED_SOLID('"; t += stepStr(bd.name); t += "',(";
        for (size_t g = 0; g < P.tgroups.size(); g++) { if (g) t += ','; appendRef(t, B + 1 + g); }
        t += "),$)";
        emitLine(out, B + P.count - 1, t);
        break;
    }
    case BK_SPHERE: {
        // Topologie canonique OCCT : une face SPHERICAL_SURFACE bornee par une
        // couture meridienne parcourue deux fois, poles = sommets (cf. _emitSphere).
        const double cxv = P.sc.x, cyv = P.sc.y, czv = P.sc.z, R = P.sr;
        uint64_t id = B;
        auto L = [&](const std::string& s) { emitLine(out, id++, s); };
        auto P3 = [&](double x, double y, double z) { t.clear(); t += "CARTESIAN_POINT"; pt3(V3{x, y, z}); return t; };
        auto D3 = [&](double x, double y, double z) { t.clear(); dir3(x, y, z); return t; };
        auto R3 = [&](const char* head, std::initializer_list<uint64_t> refs, const char* tailS) {
            t.clear(); t += head; bool first = true;
            for (uint64_t r : refs) { if (!first) t += ','; appendRef(t, r); first = false; }
            t += tailS; return t; };
        L(P3(cxv, cyv, czv));                               // B+0
        L(D3(0, 0, 1));                                     // B+1
        L(D3(1, 0, 0));                                     // B+2
        L(R3("AXIS2_PLACEMENT_3D('',", {B, B+1, B+2}, ")"));// B+3
        t.clear(); t += "SPHERICAL_SURFACE('',"; appendRef(t, B+3); t += ','; f6(R); t += ')'; L(t); // B+4
        L(P3(cxv, cyv, czv + R));                           // B+5
        L(R3("VERTEX_POINT('',", {B+5}, ")"));              // B+6
        L(P3(cxv, cyv, czv - R));                           // B+7
        L(R3("VERTEX_POINT('',", {B+7}, ")"));              // B+8
        L(P3(cxv, cyv, czv));                               // B+9
        L(D3(0, -1, 0));                                    // B+10
        L(D3(0, 0, -1));                                    // B+11
        L(R3("AXIS2_PLACEMENT_3D('',", {B+9, B+10, B+11}, ")")); // B+12
        t.clear(); t += "CIRCLE('',"; appendRef(t, B+12); t += ','; f6(R); t += ')'; L(t);    // B+13
        L(R3("EDGE_CURVE('',", {B+8, B+6, B+13}, ",.T.)")); // B+14
        L(R3("ORIENTED_EDGE('',*,*,", {B+14}, ",.T.)"));    // B+15
        L(R3("ORIENTED_EDGE('',*,*,", {B+14}, ",.F.)"));    // B+16
        L(R3("EDGE_LOOP('',(", {B+15, B+16}, "))"));        // B+17
        L(R3("FACE_OUTER_BOUND('',", {B+17}, ",.T.)"));     // B+18
        t.clear(); t += "ADVANCED_FACE('',("; appendRef(t, B+18); t += "),"; appendRef(t, B+4); t += ",.T.)"; L(t); // B+19
        L(R3("CLOSED_SHELL('',(", {B+19}, "))"));           // B+20
        t.clear(); t += "MANIFOLD_SOLID_BREP('"; t += stepStr(bd.name); t += "',"; appendRef(t, B+20); t += ')'; L(t); // B+21
        break;
    }
    }
}

// Faces d'un corps pour les styles : (#id de face, index de materiau).
static void facesOf(const Plan& P, std::vector<std::pair<uint64_t,int32_t>>& out) {
    out.clear();
    if (P.type == PT_MANIFOLD) {
        const uint64_t F0 = P.base + 2 * (uint64_t)P.verts.size() + 4 * (uint64_t)P.edges.size();
        for (const MFace& f : P.faces) out.push_back({F0 + f.start + f.count - 1, f.m});
    } else if (P.type == PT_FACETED) {
        const uint64_t T0 = P.base + (uint64_t)P.verts.size() + 3 * (uint64_t)P.fplanes.size();
        for (size_t i = 0; i < P.ftris.size(); i++) out.push_back({T0 + 3 * i + 2, P.ftris[i].m});
    } else if (P.type == PT_TESS) {
        for (size_t g = 0; g < P.tgroups.size(); g++) out.push_back({P.base + 1 + g, P.tgroups[g].m});
    } else if (P.type == PT_SPHERE) {
        out.push_back({P.base + 19, -1});
    } else if (P.type == PT_EXACT) {
        for (size_t f = 0; f < P.xfaces.size(); f++) out.push_back({P.base + P.xfaces[f].first, (int32_t)f});
    }
}

struct Stats {
    size_t parts = 0; uint64_t totalTris = 0; int nManifold = 0, nFaceted = 0, nSphere = 0, nTess = 0, nOpen = 0;
    int nExact = 0, nProtos = 0, exactMissing = 0, exactNonRigid = 0, exactFailed = 0;
    size_t styled = 0, faceStyled = 0, styleDropped = 0; int truncated = 0;
    uint64_t entities = 0, bytes = 0; unsigned threads = 0; size_t tasks = 0;
    double parseMs = 0, planMs = 0, prepMs = 0, writeMs = 0, totalMs = 0;
};

// Export pret a ecrire : tout est decide (topologie, #id, produits, styles),
// seul le texte des blocs geometriques reste a produire. head et tail sont
// petits (O(pieces + faces stylees)) ; la geometrie, elle, n'existe jamais
// en entier en memoire — cf. streamExport.
// [24/09] Le premier jet gardait tout le texte en RAM avant l'envoi : un
// assemblage de 1500 corps / 4,25 M de triangles (~3,5 Go de STEP, un B-Rep
// triangule coute ~830 octets par triangle) a ete tue par l'OOM a 7 Go sur la
// machine de banc. D'ou la meme reponse que pour l'import : du streaming.
struct Prepared {
    Request rq;
    std::vector<Plan> plans;
    std::vector<Task> tasks;
    std::string head;        // en-tete ISO 10303-21 + entites 1..13
    std::string tail;        // produits, assemblage, styles, fin de fichier
    Stats st;
    const char* apName = "AP242";
    // [24/09] Corps exacts : prototype de chaque corps (-1 = maillage) et son
    // placement rigide ; les imports cites restent vivants pendant l'export.
    std::vector<Proto> protos;
    std::vector<Plan> protoPlans;
    std::vector<int> bodyProto;
    std::vector<gp_Trsf> bodyPlace;
    std::vector<std::shared_ptr<const ImportEntry>> keep;
};

// Etage 1 : lecture, plans paralleles, somme prefixe des #id, decoupage en
// blocs, puis produits/assemblage/styles — qui ne dependent que des #id.
static void prepareExport(const std::string& body, Prepared& pp, bool showBar) {
    const auto t0 = Clock::now();
    pp.rq = parseRequest(body);
    Request& rq = pp.rq;
    Stats& st = pp.st;
    const ApInfo& ap = kAp[rq.ap];
    pp.apName = ap.name;
    const auto t1 = Clock::now();
    st.parseMs = ms(t0, t1);

    Ctx cx; cx.body = &body; cx.ap = rq.ap; cx.mode = rq.mode; cx.keyDec = rq.keyDec; cx.scale = std::pow(10.0, rq.keyDec);
    const size_t nB = rq.bodies.size();
    std::vector<Plan>& plans = pp.plans;
    plans.assign(nB, Plan());

    // ── [24/09] Corps exacts : reference -> prototype + placement ─────────
    // Sequentiel et bon marche (aucune geometrie ecrite ici). Cle de prototype :
    // forme d'origine (TShape + orientation), echelle, etat de couleur — deux
    // occurrences qui different par l'une d'elles ne partagent pas la geometrie.
    pp.bodyProto.assign(nB, -1);
    pp.bodyPlace.assign(nB, gp_Trsf());
    {
        std::map<std::tuple<const void*, int, long long, bool, uint32_t, long long>, int> protoOf;
        for (size_t i = 0; i < nB; i++) {
            const Body& bd = rq.bodies[i];
            if (bd.kind != 2) continue;
            size_t k = 0;
            auto e = findImport(bd.ref, k);
            if (!e) { st.exactMissing++; continue; }
            const ExactPart& ep = e->parts[k];
            gp_Trsf Tm;
            if (!makeTrsf(bd.xf, Tm)) { st.exactNonRigid++; continue; }
            gp_Trsf T = Tm.Multiplied(ep.part.Location().Transformation());
            const double sc = T.ScaleFactor();
            if (!(sc > 0) || !std::isfinite(sc)) { st.exactNonRigid++; continue; }
            const bool faceMap = ep.faceColors && !ep.faceColors->empty() && !(bd.xflags & 1u);
            const auto key = std::make_tuple((const void*)ep.part.TShape().get(), (int)ep.part.Orientation(),
                                             (long long)std::llround(sc * 1e9), faceMap, bd.base.rgb,
                                             (long long)std::llround(bd.base.a * 1000));
            auto it = protoOf.find(key);
            if (it == protoOf.end()) {
                Proto pr;
                pr.shape = ep.part.Located(TopLoc_Location());
                pr.base = bd.base; pr.name = bd.name;
                if (std::fabs(sc - 1.0) > 1e-12) {
                    // Echelle uniforme : la geometrie est mise a l'echelle une fois
                    // (copie), le placement reste rigide. Les couleurs de faces
                    // suivent les faces transformees.
                    gp_Trsf S; S.SetScale(gp_Pnt(0, 0, 0), sc);
                    BRepBuilderAPI_Transform tr(pr.shape, S, Standard_True);
                    if (!tr.IsDone()) { st.exactNonRigid++; continue; }
                    if (faceMap) {
                        auto nm = std::make_shared<FaceColorMap>();
                        for (TopExp_Explorer x(pr.shape, TopAbs_FACE); x.More(); x.Next()) {
                            auto c = ep.faceColors->find(x.Current().TShape().get());
                            if (c == ep.faceColors->end()) continue;
                            const TopoDS_Shape nf = tr.ModifiedShape(x.Current());
                            if (!nf.IsNull()) (*nm)[nf.TShape().get()] = c->second;
                        }
                        pr.faceColors = nm;
                    }
                    pr.shape = tr.Shape();
                } else if (faceMap) pr.faceColors = ep.faceColors;
                if (faceMap && ep.hasColor) { pr.hasUnstyled = true; pr.unstyled = FaceRGB{ep.r, ep.g, ep.b, ep.a}; }
                it = protoOf.emplace(key, (int)pp.protos.size()).first;
                pp.protos.push_back(std::move(pr));
            }
            T.SetScaleFactor(1.0);                 // placement rigide ; l'echelle est dans la geometrie
            pp.bodyProto[i] = it->second;
            pp.bodyPlace[i] = T;
            pp.keep.push_back(e);
        }
    }
    const size_t nP = pp.protos.size();
    pp.protoPlans.assign(nP, Plan());
    // Un seul espace de taches : prototypes exacts (ecriture OCCT) puis corps
    // maillage, plus gros d'abord — le dernier a finir n'est pas le plus long.
    std::vector<uint32_t> order;
    for (uint32_t i = 0; i < nB; i++) if (pp.bodyProto[i] < 0) order.push_back(i);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) { return rq.bodies[a].nTri > rq.bodies[b].nTri; });
    unsigned hw = std::thread::hardware_concurrency(); if (!hw) hw = 4;
    st.threads = hw;
    const size_t nJobs = nP + order.size();
    std::atomic<size_t> done{0}; size_t lastDrawn = 0;
    auto tick = [&]() {
        const size_t d = done.fetch_add(1) + 1;
        if (!showBar) return;
        std::lock_guard<std::mutex> lk(gConsoleMutex);
        if (d > lastDrawn && ((int)(100.0 * d / nJobs) != (int)(100.0 * lastDrawn / nJobs) || d == nJobs)) {
            drawBarLine("STEP EXPORT B-REP", (double)d / nJobs,
                std::to_string((int)(100.0 * d / nJobs)) + "%  (" + std::to_string(d) + "/" + std::to_string(nJobs) + ")");
            lastDrawn = d;
        }
    };
    std::vector<uint8_t> unsafeProto(nP, 0);   // [24/09] cf. exactGeometrySafe
    if (showBar) barPhaseStart();
    parallelForIndices(nJobs, 0, [&](size_t k) {
        if (k < nP) {
            bool ok = false, safe = false;
            try { safe = exactGeometrySafe(pp.protos[k].shape); } catch (...) { safe = false; }
            if (!safe) unsafeProto[k] = 1;
            else { try { ok = planExact(pp.protos[k], pp.protoPlans[k]); } catch (...) { ok = false; } }
            pp.protos[k].ok = ok;
            if (!ok) pp.protoPlans[k] = Plan();
        } else {
            const uint32_t i = order[k - nP];
            planBody(rq.bodies[i], cx, plans[i]);
        }
        tick();
    });
    {
        size_t nUnsafe = 0;
        for (size_t k = 0; k < nP; k++) {
            if (!unsafeProto[k]) continue;
            if (nUnsafe == 0 && showBar) barPhaseStart();
            if (++nUnsafe <= 10)
                std::cerr << cWarn() << "[STEP EXPORT]" << cReset() << " \"" << pp.protos[k].name
                          << "\": periodic B-spline with a degenerate knot vector - OCCT's STEP writer cannot open it"
                             " safely, this part is written from its mesh\n";
        }
        if (nUnsafe > 10)
            std::cerr << cWarn() << "[STEP EXPORT]" << cReset() << " ... and " << (nUnsafe - 10)
                      << " more part(s) of the same kind, written from their mesh\n";
    }
    // Prototype qu'OCCT n'a pas su ecrire : ses corps repartent en maillage.
    {
        std::vector<uint32_t> redo;
        for (uint32_t i = 0; i < nB; i++)
            if (pp.bodyProto[i] >= 0 && !pp.protos[(size_t)pp.bodyProto[i]].ok) { pp.bodyProto[i] = -1; redo.push_back(i); st.exactFailed++; }
        parallelForIndices(redo.size(), 0, [&](size_t k) { planBody(rq.bodies[redo[k]], cx, plans[redo[k]]); });
    }
    const auto t2 = Clock::now();
    st.planMs = ms(t1, t2);

    // ── En-tete de donnees (ids 1..13, ordre du JS) ───────────────────────
    std::string head; head.reserve(4096);
    uint64_t id = 0;
    std::string t;
    auto W = [&](const std::string& s) { emitLine(head, ++id, s); return id; };
    auto ref = [](uint64_t i) { std::string s; appendRef(s, i); return s; };
    auto real = [](double v, int dec) { std::string s; appendReal(s, v, dec); return s; };
    const uint64_t iAC  = W("APPLICATION_CONTEXT('" + stepStrA(ap.appCtxText) + "')");
    W("APPLICATION_PROTOCOL_DEFINITION('" + stepStrA(ap.apdStd) + "','" + stepStrA(ap.apdName) + "'," + std::to_string(ap.apdYear) + "," + ref(iAC) + ")");
    // [24/09] Unites sous leur forme NORMALISEE (entites complexes LENGTH_UNIT /
    // PLANE_ANGLE_UNIT / SOLID_ANGLE_UNIT, parties rangees par ordre alphabetique,
    // comme les ecrit OCCT). La forme heritee du writer JS
    // « (NAMED_UNIT(*) SI_UNIT($,.RADIAN.) PLANE_ANGLE_MEASURE_WITH_UNIT(...)) »
    // n'est pas une unite d'angle pour un lecteur : OCCT ne la reconnait pas comme
    // radian et relit les angles de travers. Sans consequence sur un maillage
    // (aucun angle), elle deformait tout B-Rep exact porteur d'un angle — mesure
    // sur le Scania : le demi-angle des CONICAL_SURFACE d'une vis DIN 912 M16x45
    // mal relu, 14 545 mm3 devenus 9 734 mm3.
    const uint64_t iUL  = W("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))");
    const uint64_t iUA  = W("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))");
    const uint64_t iUS  = W("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())");
    const uint64_t iUM  = W("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(" + real(rq.tol, 12) + ")," + ref(iUL) + ",'distance_accuracy_value','confusion accuracy')");
    const uint64_t iGC  = W("(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((" + ref(iUM) + ")) GLOBAL_UNIT_ASSIGNED_CONTEXT((" + ref(iUL) + "," + ref(iUA) + "," + ref(iUS) + ")) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))");
    const uint64_t iCP0 = W("CARTESIAN_POINT('',(0.,0.,0.))");
    const uint64_t iDZ0 = W("DIRECTION('',(0.,0.,1.))");
    const uint64_t iDX0 = W("DIRECTION('',(1.,0.,0.))");
    const uint64_t iAX0 = W("AXIS2_PLACEMENT_3D('',"+ ref(iCP0) + "," + ref(iDZ0) + "," + ref(iDX0) + ")");
    const uint64_t iPC  = W(std::string(ap.ctxProduct) + "(''," + ref(iAC) + ",'mechanical')");
    const uint64_t iPDC = W(std::string(ap.ctxDefApi) + "('" + stepStrA(ap.ctxDefName) + "'," + ref(iAC) + ",'design')");

    // ── Somme prefixe : premier #id de chaque corps ──────────────────────
    std::vector<uint32_t> parts;                 // corps qui produisent une piece, ordre d'entree
    for (uint32_t i = 0; i < nB; i++) {
        Plan& P = plans[i];
        st.totalTris += rq.bodies[i].nTri;
        if (pp.bodyProto[i] >= 0) {               // corps exact : sa geometrie est celle du prototype
            parts.push_back(i); st.nExact++;
            bool cut = false; stepStr(rq.bodies[i].name, 200, &cut); if (cut) st.truncated++;
            continue;
        }
        if (P.type == PT_EMPTY) continue;
        P.base = id + 1; id += P.count;
        parts.push_back(i);
        bool cut = false; stepStr(rq.bodies[i].name, 200, &cut); if (cut) st.truncated++;
        if (P.type == PT_MANIFOLD) st.nManifold++;
        else if (P.type == PT_FACETED) { st.nFaceted++; if (P.open) st.nOpen++; }
        else if (P.type == PT_TESS) { st.nTess++; if (P.open) st.nOpen++; }
        else st.nSphere++;
    }
    for (size_t j = 0; j < nP; j++) {
        Plan& P = pp.protoPlans[j];
        if (!pp.protos[j].ok) continue;
        P.base = id + 1; id += P.count;
        st.nProtos++;
    }
    // ── Decoupage en taches d'ecriture ───────────────────────────────────
    std::vector<Task>& tasks = pp.tasks;
    tasks.clear();
    auto split = [&](uint32_t b, BlockKind k, uint64_t n, uint64_t perItem) {
        if (!n) return;
        const uint64_t step = std::max<uint64_t>(1, kChunkEntities / std::max<uint64_t>(1, perItem));
        for (uint64_t i = 0; i < n; i += step) tasks.push_back(Task{b, k, i, std::min(n, i + step)});
    };
    for (uint32_t b : parts) {
        const Plan& P = plans[b];
        if (pp.bodyProto[b] >= 0) continue;       // ecrit une fois, par son prototype
        if (P.type == PT_MANIFOLD) {
            split(b, BK_MVERT, P.verts.size(), 2);
            split(b, BK_MEDGE, P.edges.size(), 4);
            // faces : taille variable -> decoupe au cumul d'entites
            uint64_t s = 0, acc = 0;
            for (uint64_t f = 0; f < P.faces.size(); f++) {
                acc += P.faces[f].count;
                if (acc >= kChunkEntities) { tasks.push_back(Task{b, BK_MFACE, s, f + 1}); s = f + 1; acc = 0; }
            }
            if (s < P.faces.size()) tasks.push_back(Task{b, BK_MFACE, s, P.faces.size()});
            tasks.push_back(Task{b, BK_MTAIL, 0, 1});
        } else if (P.type == PT_FACETED) {
            split(b, BK_FPT, P.verts.size(), 1);
            split(b, BK_FPLANE, P.fplanes.size(), 3);
            split(b, BK_FTRI, P.ftris.size(), 3);
            tasks.push_back(Task{b, BK_FTAIL, 0, 1});
        } else if (P.type == PT_TESS) {
            // Grain en ELEMENTS (points, indices, triangles), ~1 a 2 Mo de texte
            // par bloc. Un bloc vide (pnindex absent) porte quand meme l'en-tete.
            auto chunked = [&](BlockKind k, uint64_t n, uint64_t step, uint32_t aux) {
                if (!n) { tasks.push_back(Task{b, k, 0, 0, aux}); return; }
                for (uint64_t i = 0; i < n; i += step) tasks.push_back(Task{b, k, i, std::min(n, i + step), aux});
            };
            chunked(BK_TCOORD, P.verts.size(), 32768, 0);
            for (uint32_t g = 0; g < (uint32_t)P.tgroups.size(); g++) {
                chunked(BK_TPN, P.tgroups[g].pn.size(), 262144, g);
                chunked(BK_TTRI, P.tgroups[g].tri.size() / 3, 65536, g);
            }
            tasks.push_back(Task{b, BK_TSOLID, 0, 1});
        } else tasks.push_back(Task{b, BK_SPHERE, 0, 1});
    }
    for (uint32_t j = 0; j < (uint32_t)nP; j++) {
        if (!pp.protos[j].ok) continue;
        const uint64_t n = pp.protoPlans[j].xent.size();
        for (uint64_t i = 0; i < n; i += kChunkEntities) {
            Task tk{j, BK_XENT, i, std::min(n, i + kChunkEntities)}; tk.proto = true;
            tasks.push_back(tk);
        }
    }
    st.tasks = tasks.size();

    // ── Produits, assemblage, styles — sequentiel, O(pieces + faces stylees)
    std::string tail; tail.reserve(4096 + parts.size() * 1024);
    auto WT = [&](const std::string& s) { emitLine(tail, ++id, s); return id; };
    std::unordered_map<std::string, uint64_t> styleCache;
    std::vector<uint64_t> styledIds;
    auto hex6 = [](uint32_t rgb) { char b[8]; std::snprintf(b, sizeof(b), "%06x", rgb & 0xFFFFFFu); return std::string(b); };
    auto style = [&](uint32_t rgb, double a) {
        char ak[32]; std::snprintf(ak, sizeof(ak), "%.3f", a);
        const std::string k = hex6(rgb) + "|" + ak;
        auto it = styleCache.find(k); if (it != styleCache.end()) return it->second;
        const double r = ((rgb >> 16) & 255) / 255.0, g = ((rgb >> 8) & 255) / 255.0, bl = (rgb & 255) / 255.0;
        const uint64_t iRGB  = WT("COLOUR_RGB(''," + real(r, 6) + "," + real(g, 6) + "," + real(bl, 6) + ")");
        const uint64_t iFASC = WT("FILL_AREA_STYLE_COLOUR(''," + ref(iRGB) + ")");
        const uint64_t iFAS  = WT("FILL_AREA_STYLE('',(" + ref(iFASC) + "))");
        const uint64_t iSSFA = WT("SURFACE_STYLE_FILL_AREA(" + ref(iFAS) + ")");
        std::string sides = ref(iSSFA);
        if (a < 1) {
            const uint64_t iTR = WT("SURFACE_STYLE_TRANSPARENT(" + real(1 - a, 6) + ")");
            const uint64_t iRP = WT("SURFACE_STYLE_RENDERING_WITH_PROPERTIES(.NORMAL_SHADING.," + ref(iRGB) + ",(" + ref(iTR) + "))");
            sides += "," + ref(iRP);
        }
        const uint64_t iSSS = WT("SURFACE_SIDE_STYLE('',(" + sides + "))");
        const uint64_t iSSU = WT("SURFACE_STYLE_USAGE(.BOTH.," + ref(iSSS) + ")");
        const uint64_t iPSA = WT("PRESENTATION_STYLE_ASSIGNMENT((" + ref(iSSU) + "))");
        styleCache[k] = iPSA; return iPSA;
    };
    std::vector<std::pair<uint64_t,int32_t>> fl;
    auto stylePart = [&](uint32_t b) {
        if (!ap.hasColors) return;
        const Plan& P = plans[b]; const Body& bd = rq.bodies[b];
        const uint64_t psa = style(bd.base.rgb, bd.base.a);
        const uint64_t iSI = WT("STYLED_ITEM('color',(" + ref(psa) + ")," + ref(P.brepId()) + ")");
        styledIds.push_back(iSI);
        if (bd.pal.empty()) return;
        facesOf(P, fl);
        std::vector<std::pair<uint64_t,int32_t>> over;
        for (auto& fc : fl) {
            if (fc.second < 0 || (size_t)fc.second >= bd.pal.size()) continue;
            const Style& s = bd.pal[(size_t)fc.second];
            if (s.rgb != bd.base.rgb || std::fabs(s.a - bd.base.a) > 1e-3) over.push_back(fc);
        }
        if (over.size() > kMaxFaceStyles) { st.styleDropped += over.size(); return; }
        for (auto& fc : over) {
            const Style& s = bd.pal[(size_t)fc.second];
            const uint64_t p2 = style(s.rgb, s.a);
            styledIds.push_back(WT("OVER_RIDING_STYLED_ITEM('overriding color',(" + ref(p2) + ")," + ref(fc.first) + "," + ref(iSI) + ")"));
            st.faceStyled++;
        }
    };
    // [24/09] Styles d'un prototype exact : couleur de corps (celle du client)
    // sur chaque item, puis les couleurs de faces D'ORIGINE qui s'en ecartent —
    // sauf si l'utilisateur a recolore le corps (cf. Body::xflags).
    auto styleProto = [&](size_t j) {
        if (!ap.hasColors) return;
        const Proto& pr = pp.protos[j]; const Plan& P = pp.protoPlans[j];
        const uint64_t psa = style(pr.base.rgb, pr.base.a);
        uint64_t firstSI = 0;
        for (uint32_t it : P.xitems) {
            const uint64_t si = WT("STYLED_ITEM('color',(" + ref(psa) + ")," + ref(P.base + it) + ")");
            styledIds.push_back(si); if (!firstSI) firstSI = si;
        }
        auto rgbOf = [](const FaceRGB& c) {
            auto q8 = [](float v) { return (uint32_t)std::lround(std::max(0.0f, std::min(1.0f, v)) * 255.0f); };
            return (q8(c.r) << 16) | (q8(c.g) << 8) | q8(c.b);
        };
        std::vector<std::pair<uint32_t, FaceRGB>> over;
        for (auto& f : P.xfaces)
            if (rgbOf(f.second) != pr.base.rgb || std::fabs(f.second.a - pr.base.a) > 1e-3) over.push_back(f);
        if (over.size() > kMaxFaceStyles) { st.styleDropped += over.size(); return; }
        for (auto& f : over) {
            const uint64_t p2 = style(rgbOf(f.second), f.second.a);
            styledIds.push_back(WT("OVER_RIDING_STYLED_ITEM('overriding color',(" + ref(p2) + ")," + ref(P.base + f.first) + "," + ref(firstSI) + ")"));
            st.faceStyled++;
        }
    };
    std::unordered_set<std::string> usedIds;
    auto trimWs = [](const std::string& s) {
        size_t a = 0, e = s.size();
        while (a < e && std::isspace((unsigned char)s[a])) a++;
        while (e > a && std::isspace((unsigned char)s[e - 1])) e--;
        return s.substr(a, e - a);
    };
    auto uniqueId = [&](const std::string& n) {
        std::string base = trimWs(n); if (base.empty()) base = "Body";
        std::string k = base; int i = 2;
        while (usedIds.count(k)) k = base + " (" + std::to_string(i++) + ")";
        usedIds.insert(k); return k;
    };
    struct Prod { uint64_t iPr, iPDF, iPD, iPDS; };
    auto emitProduct = [&](const std::string& name) {
        const std::string pid = uniqueId(name);
        Prod p;
        p.iPr  = WT("PRODUCT('" + stepStr(pid) + "','" + stepStr(name.empty() ? pid : name) + "','',(" + ref(iPC) + "))");
        p.iPDF = WT(ap.srcSpec ? "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE(''," + std::string("'',") + ref(p.iPr) + ",.NOT_KNOWN.)"
                               : "PRODUCT_DEFINITION_FORMATION('',''," + ref(p.iPr) + ")");
        p.iPD  = WT("PRODUCT_DEFINITION('design',''," + ref(p.iPDF) + "," + ref(iPDC) + ")");
        p.iPDS = WT("PRODUCT_DEFINITION_SHAPE('',''," + ref(p.iPD) + ")");
        return p;
    };
    struct CC { uint64_t iPO, iRCr, iROw, iRSu, iRCl, iLvl, iDT, iRCrD, iRClD, iApp; } cc{};
    std::time_t now = std::time(nullptr);
    std::tm utc{};
#ifdef _WIN32
    gmtime_s(&utc, &now);
#else
    gmtime_r(&now, &utc);
#endif
    if (ap.ccDesign) {
        const uint64_t iPers = WT("PERSON('nasscad','','NASSCAD',$,$,$)");
        const uint64_t iOrg  = WT("ORGANIZATION('nasscad','NASSCAD','')");
        cc.iPO  = WT("PERSON_AND_ORGANIZATION(" + ref(iPers) + "," + ref(iOrg) + ")");
        cc.iRCr = WT("PERSON_AND_ORGANIZATION_ROLE('creator')");
        cc.iROw = WT("PERSON_AND_ORGANIZATION_ROLE('design_owner')");
        cc.iRSu = WT("PERSON_AND_ORGANIZATION_ROLE('design_supplier')");
        cc.iRCl = WT("PERSON_AND_ORGANIZATION_ROLE('classification_officer')");
        cc.iLvl = WT("SECURITY_CLASSIFICATION_LEVEL('unclassified')");
        const uint64_t iUTC = WT("COORDINATED_UNIVERSAL_TIME_OFFSET(0,$,.EXACT.)");
        const uint64_t iCal = WT("CALENDAR_DATE(" + std::to_string(utc.tm_year + 1900) + "," + std::to_string(utc.tm_mday) + "," + std::to_string(utc.tm_mon + 1) + ")");
        const uint64_t iTim = WT("LOCAL_TIME(" + std::to_string(utc.tm_hour) + "," + std::to_string(utc.tm_min) + ",$," + ref(iUTC) + ")");
        cc.iDT  = WT("DATE_AND_TIME(" + ref(iCal) + "," + ref(iTim) + ")");
        cc.iRCrD = WT("DATE_TIME_ROLE('creation_date')");
        cc.iRClD = WT("DATE_TIME_ROLE('classification_date')");
        const uint64_t iASt = WT("APPROVAL_STATUS('not_yet_approved')");
        cc.iApp = WT("APPROVAL(" + ref(iASt) + ",'')");
        const uint64_t iARo = WT("APPROVAL_ROLE('approver')");
        WT("APPROVAL_PERSON_ORGANIZATION(" + ref(cc.iPO) + "," + ref(cc.iApp) + "," + ref(iARo) + ")");
        WT("APPROVAL_DATE_TIME(" + ref(cc.iDT) + "," + ref(cc.iApp) + ")");
    }
    auto emitProductMeta = [&](const Prod& P) {
        if (ap.ccDesign) {
            const uint64_t iPRPC = WT("PRODUCT_RELATED_PRODUCT_CATEGORY('detail',$,(" + ref(P.iPr) + "))");
            const uint64_t iCat  = WT("PRODUCT_CATEGORY('part',$)");
            WT("PRODUCT_CATEGORY_RELATIONSHIP(''," + std::string("''") + "," + ref(iCat) + "," + ref(iPRPC) + ")");
            const uint64_t iSec  = WT("SECURITY_CLASSIFICATION(''," + std::string("''") + "," + ref(cc.iLvl) + ")");
            WT("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(" + ref(cc.iPO) + "," + ref(cc.iRCr) + ",(" + ref(P.iPDF) + "," + ref(P.iPD) + "))");
            WT("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(" + ref(cc.iPO) + "," + ref(cc.iROw) + ",(" + ref(P.iPr) + "))");
            WT("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(" + ref(cc.iPO) + "," + ref(cc.iRSu) + ",(" + ref(P.iPDF) + "))");
            WT("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(" + ref(cc.iPO) + "," + ref(cc.iRCl) + ",(" + ref(iSec) + "))");
            WT("CC_DESIGN_SECURITY_CLASSIFICATION(" + ref(iSec) + ",(" + ref(P.iPDF) + "))");
            WT("CC_DESIGN_DATE_AND_TIME_ASSIGNMENT(" + ref(cc.iDT) + "," + ref(cc.iRCrD) + ",(" + ref(P.iPD) + "))");
            WT("CC_DESIGN_DATE_AND_TIME_ASSIGNMENT(" + ref(cc.iDT) + "," + ref(cc.iRClD) + ",(" + ref(iSec) + "))");
            WT("CC_DESIGN_APPROVAL(" + ref(cc.iApp) + ",(" + ref(P.iPDF) + "," + ref(P.iPD) + "," + ref(iSec) + "))");
        } else {
            WT("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(" + ref(P.iPr) + "))");
        }
    };
    // TESSELLATED_SHAPE_REPRESENTATION porte directement le tessele, reliee au
    // produit par le SHAPE_DEFINITION_REPRESENTATION comme toute autre (CAx-IF,
    // cas « tessellated only »). OCCT ecrit en plus une ADVANCED_BREP_SHAPE_
    // REPRESENTATION qui contient ce meme TESSELLATED_SOLID : non conforme
    // (un tessellated_item n'est pas un item d'advanced_brep), pas repris.
    auto repOf = [&](const Plan& P) {
        if (P.type == PT_TESS) return std::string("TESSELLATED_SHAPE_REPRESENTATION");
        return std::string(P.type == PT_FACETED ? (P.open ? "MANIFOLD_SURFACE_SHAPE_REPRESENTATION" : "FACETED_BREP_SHAPE_REPRESENTATION")
                                                : "ADVANCED_BREP_SHAPE_REPRESENTATION");
    };
    const std::string rootName = "NASSCAD Model";
    if (parts.size() == 1 && pp.bodyProto[parts[0]] < 0) {
        const uint32_t b = parts[0]; const Body& bd = rq.bodies[b];
        const std::string nm = bd.name.empty() ? rootName : bd.name;
        const Prod P = emitProduct(nm);
        const uint64_t iRep = WT(repOf(plans[b]) + "('" + stepStr(nm) + "',(" + ref(iAX0) + "," + ref(plans[b].brepId()) + ")," + ref(iGC) + ")");
        WT("SHAPE_DEFINITION_REPRESENTATION(" + ref(P.iPDS) + "," + ref(iRep) + ")");
        emitProductMeta(P);
        stylePart(b);
    } else {
        const Prod Root = emitProduct(rootName);
        std::vector<uint64_t> compAx(parts.size());
        auto r12 = [](double v) { std::string x; appendReal(x, v, 12); return x; };
        for (size_t k = 0; k < parts.size(); k++) {
            const uint32_t b = parts[k];
            if (pp.bodyProto[b] < 0) {
                compAx[k] = WT("AXIS2_PLACEMENT_3D(''," + ref(iCP0) + "," + ref(iDZ0) + "," + ref(iDX0) + ")");
                continue;
            }
            // Occurrence d'un prototype exact : son placement reel dans l'assemblage.
            const gp_Trsf& T = pp.bodyPlace[b];
            const gp_Pnt o = gp_Pnt(0, 0, 0).Transformed(T);
            const gp_Dir dz = gp_Dir(0, 0, 1).Transformed(T), dx = gp_Dir(1, 0, 0).Transformed(T);
            const uint64_t iP  = WT("CARTESIAN_POINT('',(" + r12(o.X()) + "," + r12(o.Y()) + "," + r12(o.Z()) + "))");
            const uint64_t iDz = WT("DIRECTION('',(" + r12(dz.X()) + "," + r12(dz.Y()) + "," + r12(dz.Z()) + "))");
            const uint64_t iDx = WT("DIRECTION('',(" + r12(dx.X()) + "," + r12(dx.Y()) + "," + r12(dx.Z()) + "))");
            compAx[k] = WT("AXIS2_PLACEMENT_3D(''," + ref(iP) + "," + ref(iDz) + "," + ref(iDx) + ")");
        }
        std::string axl = ref(iAX0);
        for (uint64_t a : compAx) axl += "," + ref(a);
        const uint64_t iRootRep = WT("SHAPE_REPRESENTATION('" + stepStr(rootName) + "',(" + axl + ")," + ref(iGC) + ")");
        WT("SHAPE_DEFINITION_REPRESENTATION(" + ref(Root.iPDS) + "," + ref(iRootRep) + ")");
        emitProductMeta(Root);
        std::vector<Prod> protoProd(pp.protos.size());
        std::vector<uint64_t> protoRep(pp.protos.size(), 0);
        for (size_t k = 0; k < parts.size(); k++) {
            const uint32_t b = parts[k]; const Body& bd = rq.bodies[b];
            if (pp.bodyProto[b] >= 0) {
                // Prototype exact : produit + representation UNE fois, puis une
                // occurrence (NAUO + placement) par corps — l'instanciation STEP.
                const size_t j = (size_t)pp.bodyProto[b];
                const Proto& pr = pp.protos[j]; const Plan& PP = pp.protoPlans[j];
                if (!protoRep[j]) {
                    protoProd[j] = emitProduct(pr.name.empty() ? "Body " + std::to_string(k + 1) : pr.name);
                    std::string items = ref(iAX0);
                    for (uint32_t it : PP.xitems) items += "," + ref(PP.base + it);
                    protoRep[j] = WT(PP.xrep + "('" + stepStr(pr.name) + "',(" + items + ")," + ref(iGC) + ")");
                    WT("SHAPE_DEFINITION_REPRESENTATION(" + ref(protoProd[j].iPDS) + "," + ref(protoRep[j]) + ")");
                    emitProductMeta(protoProd[j]);
                    styleProto(j);
                }
                const uint64_t iNAUO = WT("NEXT_ASSEMBLY_USAGE_OCCURRENCE('" + std::to_string(k + 1) + "','" + stepStr(bd.name) + "',''," + ref(Root.iPD) + "," + ref(protoProd[j].iPD) + ",$)");
                const uint64_t iPDSp = WT("PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item'," + ref(iNAUO) + ")");
                const uint64_t iIDT  = WT("ITEM_DEFINED_TRANSFORMATION(''," + std::string("''") + "," + ref(iAX0) + "," + ref(compAx[k]) + ")");
                const uint64_t iRR   = WT("(REPRESENTATION_RELATIONSHIP(''," + std::string("''") + "," + ref(protoRep[j]) + "," + ref(iRootRep) + ") REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(" + ref(iIDT) + ") SHAPE_REPRESENTATION_RELATIONSHIP())");
                WT("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(" + ref(iRR) + "," + ref(iPDSp) + ")");
                continue;
            }
            const Prod P = emitProduct(bd.name.empty() ? "Body " + std::to_string(k + 1) : bd.name);
            const uint64_t iRep = WT(repOf(plans[b]) + "('" + stepStr(bd.name) + "',(" + ref(iAX0) + "," + ref(plans[b].brepId()) + ")," + ref(iGC) + ")");
            WT("SHAPE_DEFINITION_REPRESENTATION(" + ref(P.iPDS) + "," + ref(iRep) + ")");
            emitProductMeta(P);
            const uint64_t iNAUO = WT("NEXT_ASSEMBLY_USAGE_OCCURRENCE('" + std::to_string(k + 1) + "','" + stepStr(bd.name) + "',''," + ref(Root.iPD) + "," + ref(P.iPD) + ",$)");
            const uint64_t iPDSp = WT("PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item'," + ref(iNAUO) + ")");
            const uint64_t iIDT  = WT("ITEM_DEFINED_TRANSFORMATION(''," + std::string("''") + "," + ref(iAX0) + "," + ref(compAx[k]) + ")");
            const uint64_t iRR   = WT("(REPRESENTATION_RELATIONSHIP(''," + std::string("''") + "," + ref(iRep) + "," + ref(iRootRep) + ") REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(" + ref(iIDT) + ") SHAPE_REPRESENTATION_RELATIONSHIP())");
            WT("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(" + ref(iRR) + "," + ref(iPDSp) + ")");
            stylePart(b);
        }
    }
    if (!styledIds.empty()) {
        std::string l;
        for (size_t i = 0; i < styledIds.size(); i++) { if (i) l += ','; appendRef(l, styledIds[i]); }
        WT("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(" + l + ")," + ref(iGC) + ")");
    }
    st.styled = styledIds.size();
    st.parts = parts.size();
    st.entities = id;
    st.prepMs = ms(t2, Clock::now());

    // ── En-tete fichier (connu seulement maintenant : il cite les compteurs)
    char ts[64];
    std::snprintf(ts, sizeof(ts), "%04d-%02d-%02dT%02d:%02d:%02d", utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
                  utc.tm_hour, utc.tm_min, utc.tm_sec);
    const std::string ver = rq.version.empty() ? "?" : rq.version;
    std::string schemas = "'" + stepStrA(ap.schema) + "'";
    if (ap.schemaStyle && !styledIds.empty()) schemas += ",'" + stepStrA(ap.schemaStyle) + "'";
    std::string fh;
    fh += "ISO-10303-21;\nHEADER;\n";
    fh += "FILE_DESCRIPTION(('" + stepStr("NASSCAD V" + ver + " STEP B-Rep " + ap.name) + "'),'2;1');\n";
    fh += "FILE_NAME('model.stp','" + std::string(ts) + "',('NassLab'),(''),'NASSCAD MEDUSA','NASSCAD V" + stepStr(ver) + "','');\n";
    fh += "FILE_SCHEMA((" + schemas + "));\n";
    fh += "ENDSEC;\nDATA;\n";
    fh += "/* NASSCAD V" + ver + " - nasscad.com - " + std::to_string(rq.objCount) + " objects - " + std::to_string(parts.size())
        + " parts - " + std::to_string(st.totalTris) + " triangles - " + std::to_string(st.nManifold) + " MANIFOLD_SOLID_BREP / "
        + std::to_string(st.nFaceted) + " FACETED_BREP / " + std::to_string(st.nSphere) + " SPHERICAL_SURFACE"
        + (st.nTess ? " / " + std::to_string(st.nTess) + " TESSELLATED" : std::string())
        + (st.nExact ? " / " + std::to_string(st.nExact) + " EXACT (" + std::to_string(st.nProtos) + " prototypes)" : std::string())
        + (st.nOpen ? " / " + std::to_string(st.nOpen) + " OPEN_SHELL" : std::string())
        + (styledIds.empty() ? std::string() : " / " + std::to_string(styledIds.size()) + " styled items")
        + " - " + ap.name + " - MEDUSA native writer */\n";
    fh += head;
    pp.head = std::move(fh);
    tail += "ENDSEC;\nEND-ISO-10303-21;\n";
    pp.tail = std::move(tail);
    st.totalMs = ms(t0, Clock::now());
}

// Etage 2 : ecriture parallele ORDONNEE vers un puits (socket, fichier,
// chaine). Les producteurs tirent les blocs dans l'ordre et n'ont jamais plus
// de `window` blocs d'avance sur l'envoi : la memoire reste bornee a
// quelques dizaines de Mo quelle que soit la taille du fichier, et le premier
// octet part avant que le dernier bloc soit calcule.
// sink(const std::string&) -> bool : false = le destinataire a decroche, on
// arrete les producteurs proprement et on rend false.
template <class Sink>
static bool streamExport(Prepared& pp, Sink&& sink, bool showBar) {
    const auto t0 = Clock::now();
    Stats& st = pp.st;
    uint64_t bytes = 0;
    if (!sink(pp.head)) return false;
    bytes += pp.head.size();
    const size_t n = pp.tasks.size();
    unsigned nThreads = std::thread::hardware_concurrency(); if (!nThreads) nThreads = 4;
    nThreads = (unsigned)std::min<size_t>(nThreads, std::max<size_t>(1, n));
    const size_t window = std::max<size_t>(8, (size_t)nThreads * 4);
    std::vector<std::string> slot(n);
    std::vector<uint8_t> ready(n, 0);
    std::mutex mx; std::condition_variable cvReady, cvRoom;
    size_t next = 0, sent = 0; bool abort = false;
    std::exception_ptr err;
    std::vector<std::thread> pool;
    if (n) {
        pool.reserve(nThreads);
        for (unsigned w = 0; w < nThreads; w++) pool.emplace_back([&]() {
            for (;;) {
                size_t k;
                {
                    std::unique_lock<std::mutex> lk(mx);
                    cvRoom.wait(lk, [&] { return abort || next >= n || next < sent + window; });
                    if (abort || next >= n) return;
                    k = next++;
                }
                std::string s;
                try {
                    const Task& tk = pp.tasks[k];
                    s.reserve(1 << 20);
                    if (tk.proto) writeTask(tk, pp.protoPlans[tk.body], pp.rq.bodies.front(), s);
                    else          writeTask(tk, pp.plans[tk.body], pp.rq.bodies[tk.body], s);
                } catch (...) {
                    std::lock_guard<std::mutex> lk(mx);
                    if (!err) err = std::current_exception();
                    abort = true;
                    cvReady.notify_all(); cvRoom.notify_all();
                    return;
                }
                { std::lock_guard<std::mutex> lk(mx); slot[k] = std::move(s); ready[k] = 1; }
                cvReady.notify_all();
            }
        });
    }
    size_t lastPct = (size_t)-1;
    if (showBar && n) barPhaseStart();
    for (size_t k = 0; k < n; k++) {
        std::string s;
        {
            std::unique_lock<std::mutex> lk(mx);
            cvReady.wait(lk, [&] { return ready[k] || abort; });
            if (!ready[k]) break;                       // abandon : erreur d'un producteur
            s = std::move(slot[k]);
        }
        const bool ok = sink(s);
        bytes += s.size();
        { std::lock_guard<std::mutex> lk(mx); sent = k + 1; if (!ok) abort = true; }
        cvRoom.notify_all();
        if (!ok) { cvReady.notify_all(); break; }
        if (showBar) {
            const size_t pct = (size_t)(100.0 * (k + 1) / n);
            if (pct != lastPct) {
                std::lock_guard<std::mutex> lk(gConsoleMutex);
                drawBarLine("STEP EXPORT WRITE", (double)(k + 1) / n,
                            std::to_string(pct) + "%  (" + std::to_string(bytes >> 20) + " MB)");
                lastPct = pct;
            }
        }
    }
    for (auto& th : pool) th.join();
    if (err) std::rethrow_exception(err);
    {
        std::lock_guard<std::mutex> lk(mx);
        if (abort) return false;
    }
    if (!sink(pp.tail)) return false;
    bytes += pp.tail.size();
    st.bytes = bytes;
    st.writeMs = ms(t0, Clock::now());
    st.totalMs += st.writeMs;
    return true;
}

// Commodite (banc, --selftest-stepexport) : tout le fichier dans une chaine.
static std::string exportStepToString(const std::string& body, Stats& st) {
    Prepared pp;
    prepareExport(body, pp, false);
    std::string out;
    streamExport(pp, [&](const std::string& s) { out += s; return true; }, false);
    st = pp.st;
    return out;
}

// Premiere frame de la reponse : tout ce qui est connu AVANT l'ecriture.
// Les octets et le temps d'ecriture, le client les mesure lui-meme au fil du flux.
static std::string statsJson(const Stats& s, const char* apName) {
    std::ostringstream j;
    j << "{\"success\":true,\"ap\":\"" << apName << "\",\"parts\":" << s.parts << ",\"triangles\":" << s.totalTris
      << ",\"manifold\":" << s.nManifold << ",\"faceted\":" << s.nFaceted << ",\"spheres\":" << s.nSphere
      << ",\"tessellated\":" << s.nTess
      << ",\"exact\":" << s.nExact << ",\"prototypes\":" << s.nProtos << ",\"exactMissing\":" << s.exactMissing
      << ",\"exactNonRigid\":" << s.exactNonRigid << ",\"exactFailed\":" << s.exactFailed
      << ",\"open\":" << s.nOpen << ",\"styledItems\":" << s.styled << ",\"faceStyles\":" << s.faceStyled
      << ",\"faceStylesDropped\":" << s.styleDropped << ",\"maxFaceStyles\":" << kMaxFaceStyles
      << ",\"namesShortened\":" << s.truncated << ",\"entities\":" << s.entities
      << ",\"threads\":" << s.threads << ",\"blocks\":" << s.tasks
      << ",\"parseMs\":" << s.parseMs << ",\"planMs\":" << s.planMs << ",\"prepMs\":" << s.prepMs << "}";
    return j.str();
}

} // namespace stepx

// writeAll/writeChunk ignorent les echecs d'envoi (void) : sur /stepexport
// il faut au contraire SAVOIR que le navigateur a decroche (onglet ferme,
// watchdog client) pour arreter les producteurs au lieu d'ecrire des Go dans
// le vide.
static bool writeAllOk(SocketFD fd, const char* buf, size_t n) {
    size_t sent = 0;
    while (sent < n) {
        const int w = platformSend(fd, buf + sent, n - sent);
        if (w <= 0) return false;
        sent += (size_t)w;
    }
    return true;
}
static bool writeChunkOk(SocketFD fd, const std::string& s) {
    if (s.empty()) return true;
    char head[32];
    const int n = snprintf(head, sizeof(head), "%zx\r\n", s.size());
    return writeAllOk(fd, head, (size_t)n) && writeAllOk(fd, s.data(), s.size()) && writeAllOk(fd, "\r\n", 2);
}

// [v2.6] RAM VRAIMENT disponible, pas juste "libre". sysinfo().freeram sous
// Linux exclut le cache disque, que le noyau utilise agressivement mais
// recupere instantanement sous pression memoire — l'utiliser sous-estime
// gravement ce qui est reellement allouable. MemAvailable dans /proc/meminfo
// est calcule par le noyau lui-meme pour repondre exactement a cette
// question. Repli sur sysinfo().freeram si le fichier est illisible
// (non-Linux, conteneur restreint) — jamais d'echec silencieux total.
static long readAvailableRamMB() {
#ifdef _WIN32
    // Windows : GlobalMemoryStatusEx calcule deja, cote OS, l'equivalent exact
    // de MemAvailable (memoire physique reellement allouable, cache compris) —
    // pas besoin du double repli /proc/meminfo + sysinfo() de la branche Linux.
    MEMORYSTATUSEX statex;
    statex.dwLength = sizeof(statex);
    if (GlobalMemoryStatusEx(&statex))
        return (long)(statex.ullAvailPhys / (1024ULL*1024ULL));
    return 0; // aucune source disponible — le client doit gerer 0/absent proprement
#else
    // [v2.6] RAM VRAIMENT disponible, pas juste "libre". sysinfo().freeram sous
    // Linux exclut le cache disque, que le noyau utilise agressivement mais
    // recupere instantanement sous pression memoire — l'utiliser sous-estime
    // gravement ce qui est reellement allouable. MemAvailable dans /proc/meminfo
    // est calcule par le noyau lui-meme pour repondre exactement a cette
    // question. Repli sur sysinfo().freeram si le fichier est illisible
    // (non-Linux, conteneur restreint) — jamais d'echec silencieux total.
    std::ifstream f("/proc/meminfo");
    if (f) {
        std::string line;
        while (std::getline(f, line)) {
            if (line.rfind("MemAvailable:", 0) == 0) {
                std::istringstream iss(line.substr(13));
                long kb = 0;
                if (iss >> kb) return kb / 1024;
            }
        }
    }
    struct sysinfo si;
    if (sysinfo(&si) == 0) return (long)((si.freeram * (unsigned long long)si.mem_unit) / (1024ULL*1024ULL));
    return 0; // aucune source disponible — le client doit gerer 0/absent proprement
#endif
}

// [10/08] Journalisation fichier — sur demande de Nass : pouvoir interrompre un
// chargement qui bloque SANS perdre les infos de debogage precedant le blocage.
// Duplique chaque caractere ecrit sur std::cerr vers un fichier EN PLUS de la
// console — flush() a chaque sync() (donc a chaque endl/flush explicite deja
// present dans tout le code existant) pour que meme un arret brutal (Ctrl+C,
// fermeture de fenetre, kill) laisse les dernieres lignes intactes sur disque.
// Aucun appel std::cerr existant a modifier : rediriger UNE FOIS le streambuf
// de cerr au tout debut de main() suffit a capturer tout le fichier, present
// et futur.
// [12/08] Couleurs ANSI console — sur demande Nass, suite au rendu maquette
// (bandeau titre encadré + tags colorés) valide dans le chat. Detection isatty :
// jamais de code ANSI si stderr n'est pas un vrai terminal (redirection vers
// fichier/pipe) — comportement standard (git, ls --color=auto, etc.), evite de
// polluer une sortie non-interactive avec des sequences de controle illisibles.
// gUseColor determine UNE FOIS au demarrage (voir main()), jamais recalcule
// par ligne — cout nul en usage normal.
static bool gUseColor = false;
static const char* cOk()    { return gUseColor ? "\033[92m" : ""; }  // vert vif
// [28/08] Magenta vif reserve au NOM DU FICHIER importe, et a rien d'autre.
// Toutes les autres couleurs de ce fichier portent deja un STATUT (vert=ok,
// cyan=info/route, jaune=avertissement, rouge=erreur) : reutiliser l'une
// d'elles pour un nom de fichier lui ferait dire quelque chose de faux. Le
// magenta n'etait pas pris — il ne signifie donc que "c'est le fichier".
static const char* cFile()  { return gUseColor ? "\033[1;95m" : ""; } // magenta vif gras
static const char* cInfo()  { return gUseColor ? "\033[96m" : ""; }  // cyan vif
static const char* cWarn()  { return gUseColor ? "\033[93m" : ""; }  // jaune vif
static const char* cErr()   { return gUseColor ? "\033[91m" : ""; }  // rouge vif
static const char* cDim()   { return gUseColor ? "\033[90m" : ""; }  // gris
static const char* cBold()  { return gUseColor ? "\033[1;97m" : ""; }// blanc gras
static const char* cReset() { return gUseColor ? "\033[0m" : ""; }

// [14/08] gBarActive : declare plus haut (avant drawBarLine), gere par
// flushBuffer plus bas (voir son commentaire pour le mecanisme [15/08 FIX v2]
// a base de \r qui a remplace la coupure caractere par caractere d'origine).
// [15/08] Bufferisation — l'implementation d'origine n'appelait jamais setp(),
// donc CHAQUE caractere ecrit sur cerr declenchait un appel virtuel a
// overflow() (aucune zone tampon a remplir directement). Sur un gros
// assemblage multi-corps avec logging [COLOR]/[REPAIR] par piece, ca
// representait des dizaines de milliers d'appels virtuels rien que pour le
// logging. Ici : un vrai put-area (setp/pptr/epptr) de kBufSize octets ;
// overflow() n'est plus appele qu'une fois le tampon plein (ou a chaque sync,
// note : cerr est unitbuf par defaut, donc un sync implicite suit chaque
// operation << — le gain reel est proportionnel a la longueur moyenne d'un
// operande << , pas a kBufSize, mais reste un facteur x5 a x40 typique sur
// les lignes de ce fichier), avec une seule écriture groupee (sputn) par
// destination et par flush plutot qu'un sputc() par caractere.
// [15/08] mu_ ajoute — la tessellation STEP tourne desormais sur un pool de
// threads (cf. parallelForIndices plus bas) ; TOUS les points d'appel cerr
// atteignables depuis ces threads sont deja serialises via gConsoleMutex
// (verrouille AVANT que cerr ne soit touché), mais ce mutex interne est un
// filet de securite supplementaire — rend la classe sure par construction
// meme si un futur appel cerr oubliait gConsoleMutex, sans cout mesurable en
// usage normal (mutex non conteste = quelques dizaines de ns).
// ══ Tampon circulaire du journal ══════════════════════════════════════════
// [04/09] Le moteur ouvrait un medusa-logs-<horodatage>.txt a CHAQUE demarrage,
// sans condition, dans le dossier Telechargements. Le commentaire d'origine
// assumait deja la consequence : "le dossier se remplit si le moteur est relance
// souvent. Aucune retention automatique pour l'instant." En pratique, il se
// remplit.
//
// Le fichier n'est donc plus ecrit par defaut (--logfile le retablit a
// l'identique). A la place, les N dernieres lignes vivent ici, en memoire, et
// sortent a la demande par GET /log — ce que consomme deja le bouton meduse du
// panneau Logs de NASSCAD.
//
// Les frames de barre de progression sont volontairement EXCLUES du tampon :
// cote fichier, chaque redessin produisait une ligne horodatee, soit des
// milliers de lignes qui chassaient tout le reste. Un tampon des N dernieres
// lignes n'a d'interet que s'il contient du contenu, pas du rafraichissement
// d'affichage. C'est aussi, litteralement, le "elle fait des logs tout le
// temps" : l'essentiel du volume etait de la barre de progression.
//
// Verrouillage : logRingAppend() est appele depuis flushBuffer(), qui tient
// deja le mutex interne du Tee. logRingDump() est appele depuis un thread HTTP
// et ne journalise RIEN — l'ordre mutex-du-Tee -> gLogRingMu ne peut donc
// jamais s'inverser.
static std::mutex gLogRingMu;
static std::deque<std::string> gLogRing;
static std::string gLogRingPartial;          // ligne en cours, pas encore terminee par \n
static const size_t kLogRingMax = 20000;     // lignes conservees

static void logRingAppend(const char* s, size_t n) {
    if (!s || !n) return;
    std::lock_guard<std::mutex> lk(gLogRingMu);
    for (size_t i = 0; i < n; ++i) {
        char c = s[i];
        if (c == '\n') {
            gLogRing.push_back(gLogRingPartial);
            gLogRingPartial.clear();
            if (gLogRing.size() > kLogRingMax) gLogRing.pop_front();
        } else if (c != '\r') {
            gLogRingPartial += c;
        }
    }
}

// maxLines == 0 -> tout le tampon. La ligne en cours est incluse : sur une
// operation longue, le client doit voir la derniere ligne meme pas encore close.
static std::string logRingDump(size_t maxLines) {
    std::lock_guard<std::mutex> lk(gLogRingMu);
    const size_t total = gLogRing.size();
    const size_t start = (maxLines && total > maxLines) ? total - maxLines : 0;
    std::string out;
    out.reserve((total - start) * 80 + gLogRingPartial.size() + 1);
    for (size_t i = start; i < total; ++i) { out += gLogRing[i]; out += '\n'; }
    if (!gLogRingPartial.empty()) { out += gLogRingPartial; out += '\n'; }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// [24/09 — Nass : « certains fichiers STEP tuent MEDUSA »] RAPPORT DE PLANTAGE
//
// Un moteur qui meurt sans rien laisser ne se debogue pas : la fenetre se
// ferme, le journal en memoire part avec elle, et il ne reste qu'une
// hypothese (« probleme memoire ? »). Desormais, toute mort brutale ecrit
// medusa-crash-<horodatage>.txt a cote de l'executable (repli : dossier
// temporaire) :
//   - la cause : exception Windows (code, adresse, MODULE fautif + decalage),
//     signal POSIX, abort(), ou std::terminate avec le message de l'exception ;
//   - la derniere requete recue et la derniere barre de progression — donc la
//     phase et la piece en cours ;
//   - la memoire du process (ensemble de travail, pic, prive) et du systeme ;
//   - les 300 dernieres lignes du journal ;
//   - Windows : un minidump (.dmp) ouvrable dans Visual Studio / WinDbg, pile
//     de chaque thread comprise ; Linux : la pile du thread fautif.
// Tout est ecrit sans allocation (tampons fixes, E/S natives), depuis un
// thread neuf sous Windows (un debordement de pile n'en laisse plus au
// thread fautif). Le filtre rend ensuite la main a Windows : l'evenement 1000
// du journal Application reste enregistre comme avant.
// ═══════════════════════════════════════════════════════════════════════════
namespace crashrep {
static char gDir[1024] = "";
static std::atomic<bool> gFired{false};

struct Out {
    // create() : creation EXCLUSIVE — un rapport existant n'est jamais ecrase.
    // 1 = ouvert, 0 = le fichier existe deja, -1 = autre echec (dossier non
    // inscriptible...).
#ifdef _WIN32
    HANDLE h = INVALID_HANDLE_VALUE;
    int create(const char* path) {
        h = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) return 1;
        const DWORD e = GetLastError();
        return (e == ERROR_FILE_EXISTS || e == ERROR_ALREADY_EXISTS) ? 0 : -1;
    }
    void put(const char* s, size_t n) { DWORD w = 0; if (h != INVALID_HANDLE_VALUE && n) WriteFile(h, s, (DWORD)n, &w, nullptr); }
    void close() { if (h != INVALID_HANDLE_VALUE) { FlushFileBuffers(h); CloseHandle(h); } h = INVALID_HANDLE_VALUE; }
#else
    int fd = -1;
    int create(const char* path) {
        fd = ::open(path, O_WRONLY | O_CREAT | O_EXCL, 0644);
        return fd >= 0 ? 1 : (errno == EEXIST ? 0 : -1);
    }
    void put(const char* s, size_t n) { while (fd >= 0 && n) { const ssize_t w = ::write(fd, s, n); if (w <= 0) break; s += w; n -= (size_t)w; } }
    void close() { if (fd >= 0) { ::fsync(fd); ::close(fd); } fd = -1; }
#endif
    void puts(const char* s) { put(s, std::strlen(s)); }
    void pf(const char* fmt, ...) {
        char b[1400];
        va_list ap; va_start(ap, fmt);
        const int n = std::vsnprintf(b, sizeof b, fmt, ap);
        va_end(ap);
        if (n > 0) put(b, std::min((size_t)n, sizeof b - 1));
    }
};

static void stamp(char* out, size_t n, bool forFileName) {
    std::time_t t = std::time(nullptr);
    std::tm tmv{};
#ifdef _WIN32
    localtime_s(&tmv, &t);
#else
    localtime_r(&t, &tmv);
#endif
    std::strftime(out, n, forFileName ? "%Y-%m-%d_%H-%M-%S" : "%Y-%m-%d %H:%M:%S", &tmv);
}

// Horodatage fige au premier fichier ecrit : le .dmp et le .txt d'un meme
// plantage portent le meme nom, meme si la seconde tourne entre les deux.
static char gStampFile[40] = "";

// medusa-crash-<horodatage>.<ext> dans `dir` ; s'il existe deja (deux
// plantages dans la meme seconde : auto-tests enchaines, relance en boucle),
// <horodatage>_2, _3... — constate a l'essai : le second rapport ecrasait le
// premier, qui est pourtant le plus instructif.
static bool openIn(Out& o, const char* dir, const char* sep, const char* ext, char* path, size_t n) {
    for (int k = 1; k <= 9; ++k) {
        if (k == 1) std::snprintf(path, n, "%s%smedusa-crash-%s.%s", dir, sep, gStampFile, ext);
        else        std::snprintf(path, n, "%s%smedusa-crash-%s_%d.%s", dir, sep, gStampFile, k, ext);
        const int r = o.create(path);
        if (r > 0) return true;
        if (r < 0) return false;             // dossier inutilisable : repli
    }
    return false;
}

// Ouvre le rapport dans le dossier de l'executable, sinon dans le dossier
// temporaire. `path` recoit le chemin retenu.
static bool openReport(Out& o, const char* ext, char* path, size_t n) {
    if (!gStampFile[0]) stamp(gStampFile, sizeof gStampFile, true);
#ifdef _WIN32
    if (openIn(o, gDir, gDir[0] ? "\\" : "", ext, path, n)) return true;
    char tmp[MAX_PATH] = "";
    GetTempPathA(MAX_PATH, tmp);             // se termine deja par '\'
    return openIn(o, tmp, "", ext, path, n);
#else
    if (openIn(o, gDir, gDir[0] ? "/" : "", ext, path, n)) return true;
    return openIn(o, "/tmp", "/", ext, path, n);
#endif
}

static void memoryLines(Out& o) {
#ifdef _WIN32
    typedef BOOL (WINAPI *GpmiFn)(HANDLE, PPROCESS_MEMORY_COUNTERS, DWORD);
    GpmiFn gpmi = (GpmiFn)(void*)GetProcAddress(GetModuleHandleA("kernel32.dll"), "K32GetProcessMemoryInfo");
    PROCESS_MEMORY_COUNTERS_EX pm{};
    pm.cb = sizeof pm;
    if (gpmi && gpmi(GetCurrentProcess(), (PPROCESS_MEMORY_COUNTERS)&pm, sizeof pm))
        o.pf("Memory    : working set %llu MB (peak %llu MB), private %llu MB (peak commit %llu MB)\n",
             (unsigned long long)(pm.WorkingSetSize >> 20), (unsigned long long)(pm.PeakWorkingSetSize >> 20),
             (unsigned long long)(pm.PrivateUsage >> 20), (unsigned long long)(pm.PeakPagefileUsage >> 20));
    MEMORYSTATUSEX ms{}; ms.dwLength = sizeof ms;
    if (GlobalMemoryStatusEx(&ms))
        o.pf("System    : %llu MB physical memory available of %llu MB, commit %llu MB available of %llu MB\n",
             (unsigned long long)(ms.ullAvailPhys >> 20), (unsigned long long)(ms.ullTotalPhys >> 20),
             (unsigned long long)(ms.ullAvailPageFile >> 20), (unsigned long long)(ms.ullTotalPageFile >> 20));
#else
    // /proc lu a la main : open/read sont sures dans un gestionnaire de signal.
    auto grep = [&o](const char* file, const char* const* keys, int nk) {
        const int fd = ::open(file, O_RDONLY);
        if (fd < 0) return;
        char b[8192]; ssize_t n = ::read(fd, b, sizeof b - 1); ::close(fd);
        if (n <= 0) return;
        b[n] = 0;
        for (char* line = b; line && *line;) {
            char* nl = std::strchr(line, '\n'); if (nl) *nl = 0;
            for (int k = 0; k < nk; k++)
                if (std::strncmp(line, keys[k], std::strlen(keys[k])) == 0) { o.puts("Memory    : "); o.puts(line); o.puts("\n"); }
            line = nl ? nl + 1 : nullptr;
        }
    };
    static const char* const kSelf[] = { "VmRSS:", "VmHWM:", "VmSize:" };
    static const char* const kSys[] = { "MemAvailable:", "MemTotal:" };
    grep("/proc/self/status", kSelf, 3);
    grep("/proc/meminfo", kSys, 2);
#endif
}

static void logTail(Out& o, size_t maxLines) {
    // Les autres threads continuent de tourner pendant l'ecriture : le verrou
    // peut etre pris un instant. On insiste un peu, sans jamais bloquer — le
    // thread fautif le tient peut-etre, et ne le rendra plus.
    std::unique_lock<std::mutex> lk(gLogRingMu, std::defer_lock);
    for (int k = 0; k < 40 && !lk.try_lock(); k++) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    if (!lk.owns_lock()) { o.puts("(journal busy — not dumped)\n"); return; }
    const size_t total = gLogRing.size(), start = total > maxLines ? total - maxLines : 0;
    for (size_t i = start; i < total; ++i) { o.put(gLogRing[i].data(), gLogRing[i].size()); o.puts("\n"); }
    if (!gLogRingPartial.empty()) { o.put(gLogRingPartial.data(), gLogRingPartial.size()); o.puts("\n"); }
}

static void notice(const char* path) {
    char b[1200];
    const int n = std::snprintf(b, sizeof b, "\n[CRASH] MEDUSA crashed. Report written to %s\n", path);
    if (n <= 0) return;
#ifdef _WIN32
    DWORD w = 0; WriteFile(GetStdHandle(STD_ERROR_HANDLE), b, (DWORD)std::min((size_t)n, sizeof b - 1), &w, nullptr);
#else
    const ssize_t w = ::write(2, b, std::min((size_t)n, sizeof b - 1)); (void)w;
#endif
}

// Le rapport texte. `extra` ecrit ce qui depend de la plateforme (pile...).
template <class F>
static void writeReport(const char* cause, const char* detail, F&& extra) {
    Out o; char path[1400];
    if (!openReport(o, "txt", path, sizeof path)) return;
    char st[40]; stamp(st, sizeof st, false);
    o.puts("NASSCAD MEDUSA ENGINE 3.1 - crash report\n");
    o.pf("Time      : %s\n", st);
    o.pf("OCCT      : %s\n", OCC_VERSION_COMPLETE);
    o.pf("Cause     : %s\n", cause);
    if (detail && *detail) o.pf("Detail    : %s\n", detail);
    o.pf("Request   : %s\n", gCrashRequest);
    o.pf("Progress  : %s\n", gCrashBar);
    memoryLines(o);
    extra(o);
    o.puts("\n--- last 300 log lines ---\n");
    logTail(o, 300);
    o.close();
    notice(path);
}

#ifdef _WIN32
static const char* codeName(DWORD c) {
    switch (c) {
        case EXCEPTION_ACCESS_VIOLATION:      return "ACCESS_VIOLATION";
        case EXCEPTION_STACK_OVERFLOW:        return "STACK_OVERFLOW";
        case EXCEPTION_ILLEGAL_INSTRUCTION:   return "ILLEGAL_INSTRUCTION";
        case EXCEPTION_INT_DIVIDE_BY_ZERO:    return "INT_DIVIDE_BY_ZERO";
        case EXCEPTION_IN_PAGE_ERROR:         return "IN_PAGE_ERROR";
        case EXCEPTION_ARRAY_BOUNDS_EXCEEDED: return "ARRAY_BOUNDS_EXCEEDED";
        case EXCEPTION_PRIV_INSTRUCTION:      return "PRIV_INSTRUCTION";
        case 0xC0000409:                      return "STACK_BUFFER_OVERRUN / fail-fast";
        case 0xC0000374:                      return "HEAP_CORRUPTION";
        case 0xE06D7363:                      return "C++ exception not caught";
        default:                              return "?";
    }
}
struct SehCtx { EXCEPTION_POINTERS* ep; DWORD tid; };
static DWORD WINAPI sehWriter(LPVOID p) {
    const SehCtx* c = (const SehCtx*)p;
    const EXCEPTION_RECORD* er = c->ep->ExceptionRecord;
    HMODULE hm = nullptr; char mod[MAX_PATH] = "?";
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)er->ExceptionAddress, &hm) && hm)
        GetModuleFileNameA(hm, mod, MAX_PATH);
    const char* base = std::strrchr(mod, '\\'); base = base ? base + 1 : mod;
    char av[160] = "";
    if (er->ExceptionCode == EXCEPTION_ACCESS_VIOLATION && er->NumberParameters >= 2)
        std::snprintf(av, sizeof av, " (%s address 0x%llx)",
                      er->ExceptionInformation[0] == 0 ? "reading" : er->ExceptionInformation[0] == 1 ? "writing" : "executing",
                      (unsigned long long)er->ExceptionInformation[1]);
    char detail[700];
    std::snprintf(detail, sizeof detail, "exception 0x%08lX %s at %p = %s+0x%llx%s, thread %lu",
                  (unsigned long)er->ExceptionCode, codeName(er->ExceptionCode), er->ExceptionAddress, base,
                  (unsigned long long)((uintptr_t)er->ExceptionAddress - (uintptr_t)hm), av, (unsigned long)c->tid);
    char dmpPath[1400] = "";
    // Minidump d'abord : c'est lui qui porte les piles de tous les threads.
    {
        typedef BOOL (WINAPI *MdwdFn)(HANDLE, DWORD, HANDLE, MINIDUMP_TYPE, PMINIDUMP_EXCEPTION_INFORMATION,
                                      PMINIDUMP_USER_STREAM_INFORMATION, PMINIDUMP_CALLBACK_INFORMATION);
        HMODULE dh = LoadLibraryA("dbghelp.dll");
        MdwdFn mdwd = dh ? (MdwdFn)(void*)GetProcAddress(dh, "MiniDumpWriteDump") : nullptr;
        Out d;
        if (mdwd && openReport(d, "dmp", dmpPath, sizeof dmpPath)) {
            MINIDUMP_EXCEPTION_INFORMATION mei{};
            mei.ThreadId = c->tid; mei.ExceptionPointers = c->ep; mei.ClientPointers = FALSE;
            const MINIDUMP_TYPE t = (MINIDUMP_TYPE)(MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules
                                                    | MiniDumpWithIndirectlyReferencedMemory);
            if (!mdwd(GetCurrentProcess(), GetCurrentProcessId(), d.h, t, &mei, nullptr, nullptr)) dmpPath[0] = 0;
            d.close();
        } else dmpPath[0] = 0;
    }
    writeReport("unhandled exception", detail, [&](Out& o) {
        if (dmpPath[0]) o.pf("Minidump  : %s (open it in Visual Studio or WinDbg next to the .pdb)\n", dmpPath);
    });
    return 0;
}
static LONG WINAPI sehFilter(EXCEPTION_POINTERS* ep) {
    if (gFired.exchange(true)) return EXCEPTION_CONTINUE_SEARCH;
    SehCtx c{ep, GetCurrentThreadId()};
    HANDLE th = CreateThread(nullptr, 1u << 20, sehWriter, &c, 0, nullptr);
    if (th) { WaitForSingleObject(th, 60000); CloseHandle(th); }
    else sehWriter(&c);
    return EXCEPTION_CONTINUE_SEARCH;   // Windows enregistre et termine, comme avant
}
#else
static char gAltStack[1 << 16];
static const char* sigName(int s) {
    switch (s) { case SIGSEGV: return "SIGSEGV"; case SIGBUS: return "SIGBUS"; case SIGFPE: return "SIGFPE";
                 case SIGILL: return "SIGILL"; case SIGABRT: return "SIGABRT"; default: return "?"; }
}
static void sigHandler(int sig, siginfo_t* si, void*) {
    if (!gFired.exchange(true)) {
        char detail[200];
        std::snprintf(detail, sizeof detail, "signal %d (%s) at address %p", sig, sigName(sig), si ? si->si_addr : nullptr);
        writeReport(sig == SIGABRT ? "abort()" : "fatal signal", detail, [](Out& o) {
#if defined(__GLIBC__)
            void* fr[64];
            const int n = backtrace(fr, 64);
            o.puts("\n--- stack of the faulting thread ---\n");
            backtrace_symbols_fd(fr, n, o.fd);
#else
            (void)o;
#endif
        });
    }
    signal(sig, SIG_DFL);
    raise(sig);
}
#endif

static void onTerminate() {
    if (!gFired.exchange(true)) {
        char what[600] = "no active exception";
        if (std::exception_ptr e = std::current_exception()) {
            try { std::rethrow_exception(e); }
            catch (const std::exception& x) { std::snprintf(what, sizeof what, "uncaught exception: %s", x.what()); }
            catch (...) { std::snprintf(what, sizeof what, "uncaught non-standard exception"); }
        }
        writeReport("std::terminate", what, [](Out&) {});
    }
    std::abort();
}
static void onAbort(int) {
    if (!gFired.exchange(true)) writeReport("abort()", "", [](Out&) {});
    signal(SIGABRT, SIG_DFL);
    std::abort();
}

// A appeler une fois, au demarrage, apres la mise en place du journal.
static std::string install() {
#ifdef _WIN32
    char exe[MAX_PATH] = "";
    if (GetModuleFileNameA(nullptr, exe, MAX_PATH)) {
        char* sl = std::strrchr(exe, '\\'); if (sl) *sl = 0;
        std::snprintf(gDir, sizeof gDir, "%s", exe);
    }
    SetUnhandledExceptionFilter(sehFilter);
    signal(SIGABRT, onAbort);
#ifdef _MSC_VER
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);   // abort() passe par onAbort
#endif
#else
    char exe[1024] = "";
    const ssize_t n = ::readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n > 0) { exe[n] = 0; char* sl = std::strrchr(exe, '/'); if (sl) *sl = 0; std::snprintf(gDir, sizeof gDir, "%s", exe); }
    stack_t ss{}; ss.ss_sp = gAltStack; ss.ss_size = sizeof gAltStack; ss.ss_flags = 0;
    sigaltstack(&ss, nullptr);
    struct sigaction sa{};
    sa.sa_sigaction = sigHandler;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&sa.sa_mask);
    for (int s : { SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT }) sigaction(s, &sa, nullptr);
#endif
    std::set_terminate(onTerminate);
    return gDir[0] ? std::string(gDir) : std::string("(temporary folder)");
}
} // namespace crashrep

// [24/09] Memoire du process apres chaque gros travail : l'hypothese « probleme
// memoire » se tranche sur une ligne, pas sur une impression.
static std::string memorySummary() {
    char b[200] = "";
#ifdef _WIN32
    typedef BOOL (WINAPI *GpmiFn)(HANDLE, PPROCESS_MEMORY_COUNTERS, DWORD);
    static GpmiFn gpmi = (GpmiFn)(void*)GetProcAddress(GetModuleHandleA("kernel32.dll"), "K32GetProcessMemoryInfo");
    PROCESS_MEMORY_COUNTERS_EX pm{}; pm.cb = sizeof pm;
    if (gpmi && gpmi(GetCurrentProcess(), (PPROCESS_MEMORY_COUNTERS)&pm, sizeof pm))
        std::snprintf(b, sizeof b, "working set %llu MB (peak %llu MB), private %llu MB",
                      (unsigned long long)(pm.WorkingSetSize >> 20), (unsigned long long)(pm.PeakWorkingSetSize >> 20),
                      (unsigned long long)(pm.PrivateUsage >> 20));
#else
    long rss = -1, hwm = -1;
    std::ifstream f("/proc/self/status");
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("VmRSS:", 0) == 0) rss = std::atol(line.c_str() + 6) / 1024;
        else if (line.rfind("VmHWM:", 0) == 0) hwm = std::atol(line.c_str() + 6) / 1024;
    }
    if (rss >= 0) std::snprintf(b, sizeof b, "resident %ld MB (peak %ld MB)", rss, hwm);
#endif
    std::string out = b;
    const long avail = readAvailableRamMB();
    if (avail > 0) out += (out.empty() ? "" : ", ") + std::to_string(avail) + " MB free on the machine";
    return out;
}

class TeeStreambuf : public std::streambuf {
public:
    // file peut valoir nullptr : sans --logfile il n'y a pas de fichier, et le Tee
    // n'est plus installe QUE pour le fichier — c'est lui qui alimente le tampon
    // circulaire, donc GET /log fonctionne dans les deux cas.
    TeeStreambuf(std::streambuf* console, std::streambuf* file)
        : console_(console), file_(file), atLineStart_(true), ansiState_(0) {
        setp(buffer_, buffer_ + kBufSize);
    }
protected:
    virtual int overflow(int c) override {
        std::lock_guard<std::mutex> lk(mu_);
        if (pptr() > pbase()) {
            flushBuffer(pbase(), pptr());
            setp(buffer_, buffer_ + kBufSize);
        }
        if (c == EOF) return !EOF;
        *pptr() = (char)c;
        pbump(1);
        return c;
    }
    virtual int sync() override {
        std::lock_guard<std::mutex> lk(mu_);
        if (pptr() > pbase()) {
            flushBuffer(pbase(), pptr());
            setp(buffer_, buffer_ + kBufSize);
        }
        int r1 = console_->pubsync();
        int r2 = file_ ? file_->pubsync() : 0;   // [04/09] file_ peut etre nul : sans --logfile
        return (r1 == 0 && r2 == 0) ? 0 : -1;
    }
private:
    static constexpr std::streamsize kBufSize = 4096;
    std::streambuf* console_;
    std::streambuf* file_;
    bool atLineStart_;
    int ansiState_;
    char buffer_[kBufSize];
    std::mutex mu_;

    // [15/08 FIX v2] Reecrit pour la barre a base de \r (plus d'ANSI). Applique
    // la logique caractere-par-caractere sur TOUT le tampon [first,last),
    // accumule le resultat par destination, puis n'ecrit qu'UNE fois par
    // destination (sputn groupe).
    //
    // Principe cle : cerr etant unitbuf, un sync() (donc UN appel a
    // flushBuffer) couvre exactement le contenu d'UN "std::cerr << ..."
    // complet — jamais un melange de deux appels distincts. drawBarLine()
    // commence TOUJOURS par '\r' ; aucun autre point d'appel de ce fichier
    // n'ecrit de \r sur cerr. Le premier octet du tampon suffit donc a
    // distinguer fiablement "ceci est une frame de barre" de "ceci est un log
    // normal" pour CET appel.
    //
    // Ancien mecanisme (jusqu'au 15/08) : pendant qu'une barre tournait,
    // gBarActive supprimait caractere par caractere tout log normal sur la
    // CONSOLE, sauf son \n final — qui, lui, passait toujours. Resultat :
    // chaque log supprime laissait une ligne vide sur la console (rien de
    // perdu dans medusa.log, mais l'affichage EN DIRECT se remplissait de
    // lignes vides des qu'une barre restait active pendant plusieurs logs
    // consecutifs — exactement le bug signale par Nass).
    //
    // Nouveau mecanisme : rien n'est jamais supprime. Si une frame de barre
    // est "ouverte" (gBarActive) au moment ou un log NORMAL arrive, on ferme
    // proprement cette ligne avec un vrai '\n' AVANT de laisser passer le
    // log — la barre reprendra sur sa propre ligne a la frame suivante. Le
    // log lui-meme part en entier, comme n'importe quel autre log.
    void flushBuffer(const char* first, const char* last) {
        if (first == last) return;

        // [15/08 FIX v4] Marqueur '\x01' = ecriture FICHIER UNIQUEMENT (voir
        // logFileOnly plus haut) — court-circuite tout le reste : jamais
        // touche a la console, jamais touche a gBarActive. Une barre en
        // cours sur la console continue de s'ecraser sur place sans se
        // soucier une seconde de ce que ce log envoie au fichier.
        if (*first == '\x01') {
            std::string fileOnlyAcc;
            fileOnlyAcc.reserve((size_t)(last - first) + 16);
            for (const char* p = first + 1; p != last; ++p) { // +1 : saute le marqueur
                char c = *p;
                if (atLineStart_) {
                    fileOnlyAcc += timestamp();
                    atLineStart_ = false;
                }
                fileOnlyAcc += c;
                if (c == '\n') atLineStart_ = true;
            }
            if (!fileOnlyAcc.empty()) {
                if (file_) file_->sputn(fileOnlyAcc.data(), (std::streamsize)fileOnlyAcc.size());
                logRingAppend(fileOnlyAcc.data(), fileOnlyAcc.size()); // detail [COLOR]/REPAIR : du contenu, il entre
            }
            return;
        }

        std::string consoleAcc, fileAcc;
        consoleAcc.reserve((size_t)(last - first) + 16);
        fileAcc.reserve((size_t)(last - first) + 16);

        bool isBarFrame = (*first == '\r');

        // Ferme une frame de barre restee ouverte avant tout contenu qui n'en
        // est pas une nouvelle. Cas particulier : le '\n' isole emis par
        // barPhaseStart() EST deja cette fermeture — pas de doublon dans ce cas.
        if (gBarActive && !isBarFrame) {
            if (!(last - first == 1 && *first == '\n')) {
                consoleAcc += '\n';
                fileAcc += '\n';
                atLineStart_ = true;
            }
            gBarActive = false;
        }

        for (const char* p = first; p != last; ++p) {
            char c = *p;

            if (isBarFrame && c == '\r') {
                // Debut/reecriture d'une frame : la console recoit le \r brut (le
                // mecanisme d'ecrasement sur place lui-meme, aucun ANSI requis) ;
                // le fichier recoit une NOUVELLE ligne horodatee a la place — une
                // ligne par frame, lisible dans medusa.log, comme avant le passage
                // au \r (aucune trace de \r cru dans le fichier).
                consoleAcc += '\r';
                atLineStart_ = true; // force l'horodatage FICHIER ci-dessous pour cette frame
                continue;
            }
            // [10/08] Horodatage automatique en tete de ligne — meme format que
            // NASSCAD ([HH:MM:SS]) pour permettre une analyse comparative directe
            // entre les deux logs. Pour une frame de barre, seul le FICHIER recoit
            // l'horodatage (la console redessine trop souvent pour que ce soit
            // lisible en direct — pur bruit visuel a chaque \r).
            if (atLineStart_) {
                std::string ts = timestamp();
                if (isBarFrame) fileAcc += '\n';
                fileAcc += ts;
                if (!isBarFrame) consoleAcc += ts;
                atLineStart_ = false;
            }
            // [12/08] Filtrage ANSI pour le fichier UNIQUEMENT — la console recoit
            // les couleurs (cOk/cInfo/cWarn/cErr, cf. plus haut : bandeau de
            // demarrage), mais medusa.log doit rester du texte brut lisible dans
            // Notepad. N'entre en jeu que pour les logs normaux : une frame de
            // barre ne contient jamais de sequence ANSI desormais.
            bool toFile = true;
            if (!isBarFrame) {
                if (ansiState_ == 0) {
                    if ((unsigned char)c == 0x1B) { ansiState_ = 1; toFile = false; }
                } else if (ansiState_ == 1) {
                    toFile = false;
                    ansiState_ = (c == '[') ? 2 : 0; // sequence non reconnue -> repli normal
                } else if (ansiState_ == 2) {
                    toFile = false;
                    if (c >= 0x40 && c <= 0x7E) ansiState_ = 0; // octet final CSI (ex: 'm')
                }
            }
            consoleAcc += c;
            if (toFile) fileAcc += c;
            if (c == '\n') atLineStart_ = true;
        }

        if (isBarFrame) gBarActive = true; // ligne encore "ouverte" sur la console jusqu'a la prochaine frame/fermeture

        if (!consoleAcc.empty()) console_->sputn(consoleAcc.data(), (std::streamsize)consoleAcc.size());
        if (!fileAcc.empty()) {
            if (file_) file_->sputn(fileAcc.data(), (std::streamsize)fileAcc.size());
            // Une frame de barre n'est pas du contenu : elle redessine. Elle va au
            // fichier si on en a demande un, jamais dans le tampon des N dernieres
            // lignes — sinon elle le viderait de tout le reste en quelques secondes.
            if (!isBarFrame) logRingAppend(fileAcc.data(), fileAcc.size());
        }
    }
    static std::string timestamp() {
        auto now = std::chrono::system_clock::now();
        std::time_t t = std::chrono::system_clock::to_time_t(now);
        std::tm tmBuf{};
#ifdef _WIN32
        localtime_s(&tmBuf, &t); // Windows — equivalent thread-safe, ordre d'arguments inverse de localtime_r
#else
        localtime_r(&t, &tmBuf); // WSL/Linux — localtime_r thread-safe
#endif
        char buf[16];
        std::strftime(buf, sizeof(buf), "[%H:%M:%S]", &tmBuf);
        return std::string(buf);
    }
};

// [10/08] Detection dynamique du dossier Telechargements Windows, depuis WSL —
// sur demande de Nass (log accessible directement, pas enfoui dans WSL).
// JAMAIS de nom d'utilisateur code en dur (lecon apprise plusieurs fois cette
// nuit sur d'autres scripts) : interroge %USERPROFILE% via cmd.exe (toujours
// present sur Windows, aucun paquet WSL supplementaire requis), puis convertit
// en chemin WSL via wslpath (utilitaire natif WSL, pas un ajout externe).
// Repli sur chemin relatif (comportement precedent) si l'interop echoue pour
// N'IMPORTE QUELLE raison (interop desactive, cmd.exe introuvable, etc.) —
// jamais de log perdu, juste moins pratique a trouver dans ce cas.
// ═══════════════════════════════════════════════════════════════════════════
// [28/08] stepHeaderInfo — nom du fichier STEP importe, lu dans l'EN-TETE du
// fichier lui-meme.
//
// POURQUOI PAS LE VRAI NOM DE FICHIER. Le protocole ne le transporte pas : le
// client POSTe le buffer STEP brut, sans metadonnee. Le faire remonter aurait
// demande de propager le nom depuis le selecteur de fichier a travers
// _readStepFileOffloaded -> _readStepFileViaBooster(Stream) -> query string,
// donc modifier le client ET le serveur pour une ligne de log. Alors que
// l'information est DEJA dans les octets recus : tout fichier ISO 10303-21
// commence par un en-tete qui porte son propre nom.
//
//   ISO-10303-21;
//   HEADER;
//   FILE_DESCRIPTION((''),'2;1');
//   FILE_NAME('Scania-Engine-V8-XT-Turbo.step','2026-08-20T09:12:44',('Nasser'),
//             (''),'Open CASCADE STEP processor 7.7','SolidWorks 2023','');
//
// Arguments de FILE_NAME selon la norme : 1=name, 2=time_stamp, 3=author,
// 4=organization, 5=preprocessor_version, 6=originating_system, 7=authorisation.
// On prend le 1 (le nom) et le 6 (le logiciel d'origine — gratuit une fois
// qu'on parse, et il explique souvent les conventions de couleur du fichier).
//
// LIMITE ASSUMEE : c'est le nom AU MOMENT DE L'EXPORT, pas celui du fichier sur
// le disque. Un fichier renomme depuis affichera son ancien nom. C'est le prix
// du zero-changement-de-protocole, et ca reste plus informatif que rien.
//
// Robustesse : bornee aux premiers 64 Ko (l'en-tete est toujours en tete), ne
// leve jamais, rend des champs vides si le corps n'est pas du STEP (buffer
// compresse .stpz, POST hostile) — l'appelant affiche alors juste la taille.
// ═══════════════════════════════════════════════════════════════════════════
struct StepHeaderInfo { std::string name; std::string system; };

// [28/08 FIX] Deux corrections apres le premier fichier Inventor reel.
//
// (1) COMMENTAIRES ISO 10303-21. Part 21 autorise /* ... */ N'IMPORTE OU dans
//     la structure d'echange, et Autodesk Inventor annote chaque champ :
//        FILE_NAME('x.step','2018-..',(''),(''),'pp',/*originating_system*/'Inventor 2018','');
//     Le parseur accumulait ces commentaires dans la valeur, d'ou l'affichage
//     "/*originating_system*/Autodesk Inventor 2018". Il faut donc les sauter —
//     et les sauter VRAIMENT, avec un etat dedie : un commentaire peut contenir
//     une apostrophe (/* export de Nasser's */) qui ferait basculer l'etat
//     "chaine" et decalerait tous les arguments suivants.
//
// (2) RETOURS LIGNE DANS UNE CHAINE. Certains exporteurs cassent mecaniquement
//     les lignes d'en-tete a une colonne fixe, AU MILIEU du nom de fichier. Le
//     \n brut atterrissait dans la valeur, partait sur la console, et
//     TeeStreambuf — qui horodate en debut de ligne — coupait le nom en deux
//     avec un second horodatage ("[FILE] Engi" / "[..]ne V8-XT Turbo.step").
//     Regle generale qui en decoule : une valeur destinee a une ligne de log ne
//     doit JAMAIS contenir de caractere de controle. On les retire, et on borne
//     la longueur — un champ pathologique ne doit pas noyer la console.
//
// REGLE D'ACCUMULATION SIMPLIFIEE au passage : seul ce qui vient de l'INTERIEUR
// d'une chaine entre apostrophes, au niveau 0 de parenthesage, entre dans une
// valeur. Tout jeton nu ($, *, commentaire, espace) est ignore par construction
// — c'est ce qui rend (1) robuste plutot que rustine.

// Retire les caracteres de controle et borne la longueur, pour affichage.
static std::string sanitizeForLog(const std::string& in, size_t maxLen = 120) {
    std::string out;
    out.reserve(in.size());
    for (unsigned char c : in) {
        if (c < 0x20 || c == 0x7F) continue;   // \n, \r, \t, ESC...
        out += (char)c;
    }
    // "..." en ASCII plutot que l'ellipse U+2026 : \u2026 dans un litteral
    // etroit depend du jeu d'execution du compilateur (MSVC sans /utf-8 rale),
    // et une troncature de log ne merite pas ce risque.
    if (out.size() > maxLen) out = out.substr(0, maxLen - 3) + "...";
    return out;
}

static StepHeaderInfo stepHeaderInfo(const std::string& body) {
    StepHeaderInfo out;
    const size_t scan = std::min<size_t>(body.size(), 64 * 1024);
    size_t p = body.find("FILE_NAME", 0);
    if (p == std::string::npos || p >= scan) return out;
    p = body.find('(', p);
    if (p == std::string::npos) return out;
    p++;

    enum { CODE, STR, COMMENT } st = CODE;
    std::vector<std::string> args;
    std::string cur;
    int depth = 0;

    for (; p < scan && args.size() < 7; p++) {
        char c = body[p];

        if (st == COMMENT) {
            if (c == '*' && p + 1 < scan && body[p + 1] == '/') { st = CODE; p++; }
            continue;
        }
        if (st == STR) {
            if (c == '\'') {
                if (p + 1 < scan && body[p + 1] == '\'') { if (depth == 0) cur += '\''; p++; } // '' echappe
                else st = CODE;
            } else if (depth == 0) cur += c;   // contenu de chaine, niveau 0 uniquement
            continue;
        }
        // st == CODE
        if (c == '/' && p + 1 < scan && body[p + 1] == '*') { st = COMMENT; p++; continue; }
        if (c == '\'') { st = STR; continue; }
        if (c == '(') { depth++; continue; }
        if (c == ')') {
            if (depth == 0) { args.push_back(cur); break; }   // fin de FILE_NAME(...)
            depth--; continue;
        }
        if (c == ',' && depth == 0) { args.push_back(cur); cur.clear(); continue; }
        // Tout le reste au niveau 0 hors chaine ($, *, espaces) : ignore.
    }

    if (!args.empty()) {
        std::string n = sanitizeForLog(args[0]);
        // Certains exporteurs ecrivent un chemin complet : on ne garde que le
        // nom de base, seule partie utile dans une ligne de log.
        size_t slash = n.find_last_of("/\\");
        if (slash != std::string::npos) n = n.substr(slash + 1);
        out.name = n;
    }
    if (args.size() >= 6) out.system = sanitizeForLog(args[5], 60);
    return out;
}

// Taille lisible — evite "365572 KB" quand "357.0 MB" dit la meme chose.
static std::string humanBytes(size_t n) {
    char buf[64];
    if (n >= 1024ull * 1024 * 1024) std::snprintf(buf, sizeof(buf), "%.2f GB", n / (1024.0 * 1024 * 1024));
    else if (n >= 1024ull * 1024)   std::snprintf(buf, sizeof(buf), "%.1f MB", n / (1024.0 * 1024));
    else if (n >= 1024)             std::snprintf(buf, sizeof(buf), "%.1f KB", n / 1024.0);
    else                            std::snprintf(buf, sizeof(buf), "%zu B", n);
    return std::string(buf);
}

// ═══════════════════════════════════════════════════════════════════════════
// [21/09 — Nass] PRESENCE DU CLIENT — « est-ce que NASSCAD est la ? »
// ═══════════════════════════════════════════════════════════════════════════
// La console annoncait « Ready. » puis se taisait. Impossible de savoir, en la
// regardant, si un NASSCAD etait accroche ou si le moteur attendait dans le
// vide — et c'est pourtant la premiere question qu'on se pose devant elle.
//
// Aucun protocole a inventer pour y repondre : le client sonde deja
// GET /ping au demarrage (cf. _detectBooster dans step-import.js, qui logue le
// symetrique cote navigateur : « NASSCAD Engine detected »). Ce ping EST le
// signal de presence. On se contente de le reconnaitre.
//
// Detection AU CONTACT, pas sur minuterie. C'est un choix, pas un raccourci :
// le client met son resultat en cache pour la session (_boosterState) et ne
// re-sonde qu'en cas d'echec, une fois par minute au plus. Il n'y a donc PAS
// de battement de coeur, et donc aucun moyen honnete de detecter une
// deconnexion. Annoncer « NASSCAD disconnected » apres un silence serait
// inventer une information : un utilisateur qui reflechit dix minutes devant
// sa piece n'est pas parti. On dit ce qu'on sait — quelqu'un vient de parler —
// et rien de plus.
//
// Un /ping SUIVANT le premier, en revanche, a un sens precis : seule une page
// neuve sonde. C'est donc un rechargement ou un nouvel onglet, et ca vaut une
// ligne, avec le temps de silence ecoule.
//
// Cout : un atomic, un time_point, aucun thread, aucune allocation sur le
// chemin chaud (les requetes non-/ping ne font qu'ecrire l'horodatage).
// ═══════════════════════════════════════════════════════════════════════════
static const Clock::time_point gEngineStart = Clock::now();
static std::atomic<int> gClientPings{0};
static Clock::time_point gClientLastSeen;   // sous gConsoleMutex

// Duree lisible : on ne veut pas lire « 843,2 s » dans une console.
static std::string humanDuration(double msec) {
    const long long sec = (long long)(msec / 1000.0 + 0.5);
    std::ostringstream o;
    if (sec < 90) o << sec << " s";
    else if (sec < 5400) o << (sec / 60) << " min";
    else {
        o << (sec / 3600) << " h ";
        const long long m = (sec % 3600) / 60;
        if (m < 10) o << "0";
        o << m;
    }
    return o.str();
}

static void noteClientContact(const HttpRequest& req) {
    const bool isPing = (req.path == "/ping" || req.path.rfind("/ping?", 0) == 0);
    const Clock::time_point now = Clock::now();
    std::lock_guard<std::mutex> lk(gConsoleMutex);
    const Clock::time_point prev = gClientLastSeen;
    gClientLastSeen = now;
    if (!isPing) return;                     // toute requete rafraichit, seul /ping parle

    const int n = gClientPings.fetch_add(1) + 1;
    if (n == 1) {
        std::cerr << cOk() << "[OK]" << cReset() << " "
                  << cBold() << "NASSCAD connected" << cReset()
                  << " — ready to load and compute"
                  << cDim() << "   (" << req.method << " " << req.path << ", "
                  << humanDuration(ms(gEngineStart, now)) << " after start)"
                  << cReset() << "\n";
    } else {
        std::cerr << cInfo() << "[INFO]" << cReset() << " "
                  << cBold() << "NASSCAD reconnected" << cReset()
                  << " — page reloaded or new tab"
                  << cDim() << "   (client #" << n << ", "
                  << humanDuration(ms(prev, now)) << " since last request)"
                  << cReset() << "\n";
    }
}

// Ligne d'annonce commune a /step et /stepstream, emise DES l'arrivee de la
// requete — donc juste sous "Ready." au premier import, avant la barre PARSING.
static void logStepFileBanner(const std::string& body, const char* route) {
    StepHeaderInfo h = stepHeaderInfo(body);
    std::ostringstream oss;
    oss << cInfo() << "[FILE]" << cReset() << " "
        << cFile() << (h.name.empty() ? "(no name in STEP header)" : h.name) << cReset()
        << cDim() << "  " << humanBytes(body.size());
    if (!h.system.empty()) oss << "  |  " << h.system;
    oss << "  |  " << route << cReset() << "\n";
    std::cerr << oss.str();
}

// [28/08] Horodatage pour NOM DE FICHIER : YYYY-MM-DD_HH-MM-SS, heure locale.
// Strictement le meme format que _fmtLogFilename() dans nasscad_logs.js — les
// deux journaux d'une session doivent porter le meme cachet.
static std::string logFileStamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tmBuf{};
#ifdef _WIN32
    localtime_s(&tmBuf, &t);
#else
    localtime_r(&t, &tmBuf);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d_%H-%M-%S", &tmBuf);
    return std::string(buf);
}

static std::string getWindowsDownloadsPath() {
#ifdef _WIN32
    // Windows natif : %USERPROFILE% est deja un chemin Windows direct — le
    // detour cmd.exe + wslpath de la branche ci-dessous n'existe que pour
    // traverser la frontiere WSL->Windows, inutile ici (meme demarche que
    // l'ancien "echo %USERPROFILE%", juste sans le relais de sous-systeme).
    const char* profile = std::getenv("USERPROFILE");
    if (!profile || !*profile) return "";
    return std::string(profile) + "\\Downloads";
#else
    FILE* pipe1 = popen("cmd.exe /c \"echo %USERPROFILE%\" 2>/dev/null", "r");
    if (!pipe1) return "";
    char buf[512];
    std::string winPath;
    if (fgets(buf, sizeof(buf), pipe1)) winPath = buf;
    pclose(pipe1);
    while (!winPath.empty() && (winPath.back()=='\n' || winPath.back()=='\r')) winPath.pop_back();
    if (winPath.empty() || winPath.find("%USERPROFILE%") != std::string::npos) return ""; // echo non substitue = echec

    std::string cmd2 = "wslpath \"" + winPath + "\" 2>/dev/null";
    FILE* pipe2 = popen(cmd2.c_str(), "r");
    if (!pipe2) return "";
    std::string wslPath;
    if (fgets(buf, sizeof(buf), pipe2)) wslPath = buf;
    pclose(pipe2);
    while (!wslPath.empty() && (wslPath.back()=='\n' || wslPath.back()=='\r')) wslPath.pop_back();
    if (wslPath.empty()) return "";

    return wslPath + "/Downloads";
#endif
}

// [15/08] Mode diagnostic CLI "--decode-colors fichier.step" -- reutilise
// collectLeaves(), LA MEME fonction qu'utilise processStepBuffer() pour
// resoudre les couleurs d'une vraie requete /step : donc AUCUN risque de
// divergence entre ce que ce mode affiche et ce que le serveur fera
// reellement, aujourd'hui et apres n'importe quelle future modification de
// collectLeaves() -- contrairement a un outil standalone separe (teste le
// 15/08, voir decode_couleurs_step.cpp) qui doit etre maintenu a la main en
// parallele.
// [CORRIGE 26/08] L'ancien commentaire affirmait ici que "les composantes
// renvoyees par Quantity_Color sont deja celles qu'OCCT a resolues depuis le
// fichier" : c'etait faux depuis OCCT 7.5 (stockage lineaire), et ce mode
// diagnostic affichait donc des valeurs qui n'etaient pas celles du fichier --
// ce qui a valide plusieurs fausses pistes. La sortie passe desormais par
// occtColorToSRGB() (cf. sa doc), comme le reste du pipeline. Usage :
//   ./nasscad_medusa --decode-colors fichier.step
// Lit le fichier sur disque (pas depuis une requete HTTP), n'ouvre PAS le
// port serveur, n'ecrit PAS medusa.log — juste la resolution, puis quitte.
static int runDecodeColorsCli(const std::string& stepPath) {
    std::ifstream f(stepPath, std::ios::binary);
    if (!f) {
        std::cerr << cWarn() << "[ERROR]" << cReset() << " file not found: " << stepPath << "\n";
        return 1;
    }
    std::ostringstream ss;
    ss << f.rdbuf();
    std::string body = ss.str();

    Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader caf;
    caf.SetNameMode(Standard_True);
    caf.SetColorMode(Standard_True);
    caf.SetLayerMode(Standard_False);
    caf.SetGDTMode(Standard_False);

    std::istringstream stream(body, std::ios::binary);
    IFSelect_ReturnStatus stat = caf.ChangeReader().ReadStream("decode_input.step", stream);
    if (stat != IFSelect_RetDone) {
        std::cerr << cWarn() << "[ERROR]" << cReset() << " STEP read failed (corrupted or non-STEP file?)\n";
        return 1;
    }
    if (!caf.Transfer(doc)) {
        std::cerr << cWarn() << "[ERROR]" << cReset() << " XCAF transfer failed\n";
        return 1;
    }

    Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) colorTool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    TDF_LabelSequence freeShapes;
    shapeTool->GetFreeShapes(freeShapes);

    std::vector<LeafShape> leaves;
    for (Standard_Integer i = 1; i <= freeShapes.Length(); i++) {
        collectLeaves(shapeTool, colorTool, freeShapes.Value(i), TopLoc_Location(), leaves, 0);
    }

    std::cerr << cBold() << "--- " << stepPath << " : " << leaves.size() << " part(s) ---" << cReset() << "\n";
    int nColored = 0;
    char line[256];
    for (auto& leaf : leaves) {
        if (leaf.color) {
            // [26/08] sRGB : ces valeurs doivent maintenant correspondre EXACTEMENT
            // au COLOUR_RGB lisible en clair dans le fichier STEP. C'est le critere
            // de validation de toute la chaine couleur.
            double r, g, b;
            occtColorToSRGB(*leaf.color, r, g, b);
            int r255 = (int)std::lround(r * 255.0), g255 = (int)std::lround(g * 255.0), b255 = (int)std::lround(b * 255.0);
            std::snprintf(line, sizeof(line),
                "  \"%.60s\" : floats=(%.6f, %.6f, %.6f)  RGB=(%d,%d,%d)  #%02X%02X%02X",
                leaf.name.c_str(), r, g, b, r255, g255, b255, r255, g255, b255);
            std::cerr << cOk() << line << cReset() << "\n";
            nColored++;
        } else {
            std::snprintf(line, sizeof(line), "  \"%.60s\" : no color found (label/proto/face all empty)", leaf.name.c_str());
            std::cerr << cWarn() << line << cReset() << "\n";
        }
    }
    std::cerr << cBold() << "--- " << nColored << "/" << leaves.size() << " part(s) colored ---" << cReset() << "\n";
    return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// [27/08] CSG — soudure des vertices par position, HISSEE au scope fichier.
// Etait une lambda locale au handler POST /csg ; /csgtree (juste en dessous)
// en a besoin sur chaque feuille de l arbre, et dupliquer 35 lignes d open
// addressing quantifie serait le meilleur moyen de laisser les deux copies
// diverger au prochain reglage de tolerance. Corps INCHANGE, seule la portee
// change — /csg appelle desormais cette fonction au lieu de sa lambda.
//
// Necessaire car les geometries THREE.js (SphereGeometry, CylinderGeometry...)
// dupliquent des vertices geometriquement identiques a la couture UV (indices
// differents, meme position) pour porter des coordonnees de texture distinctes.
// Manifold verifie le manifold par ADJACENCE D INDEX, pas par coincidence de
// position -- la couture non soudee ressemble alors a une frontiere d aretes
// nues -> MANIFOLD_NOT_MANIFOLD systematique sur toute sphere/cylindre envoye
// tel quel. Meme technique que le weld deja optimise cote NASSCAD (open
// addressing + comparaison EXACTE des coordonnees quantifiees, pas le hash
// seul comme cle -- evite les faux-positifs de collision).
// ═══════════════════════════════════════════════════════════════════════════
static void weldMeshForCSGLegacy(std::vector<float>& pos, std::vector<uint32_t>& idx) {
    const double tol = 1e-4;
    size_t nVert = pos.size() / 3;
    // [FIX] Cles en int64. llround rend un long long ; la troncature en int32
    // debordait silencieusement des |coord| > 214 748 unites (2^31 * tol).
    // Portee reelle de cette troncature : limitee. Des ~10 000 unites le pas du
    // float (9.8e-4 a 10k, 1.6e-2 a 214k) depasse deja tol=1e-4, donc deux
    // floats voisins y sont separes de ~156 cles : une collision modulo 2^32 est
    // improbable, pas systematique. Le correctif supprime surtout une troncature
    // muette, il ne coute rien, et il tiendra si tol change un jour.
    // Le hash tronque toujours en 32 bits (licite pour un hash) ; seule la
    // comparaison exacte garantit la correction, et elle porte desormais sur les
    // 64 bits complets.
    //
    // NOTE — la vraie limite de ce soudage n'est pas la troncature mais tol,
    // fige a 1e-4 quelle que soit l'echelle du modele. Au-dela de ~10 m en mm il
    // ne fusionne plus que les sommets identiques au bit pres : il cesse
    // silencieusement de souder, ce qui laisse des sommets dupliques donc des
    // fissures, donc du non-manifold, precisement sur les gros assemblages.
    // Indexer tol sur la bbox (cf. rootDeflectionLikeOcctImportJs) reglerait ca.
    auto quant = [&](float v){ return (int64_t)std::llround((double)v / tol); };
    std::vector<int64_t> qx(nVert), qy(nVert), qz(nVert);
    for (size_t i = 0; i < nVert; i++) {
        qx[i] = quant(pos[i*3]); qy[i] = quant(pos[i*3+1]); qz[i] = quant(pos[i*3+2]);
    }
    size_t cap = 1; while (cap < nVert * 2) cap <<= 1;
    size_t mask = cap - 1;
    std::vector<int32_t> table(cap, -1);
    std::vector<uint32_t> remap(nVert);
    std::vector<float> welded; welded.reserve(pos.size());
    for (size_t i = 0; i < nVert; i++) {
        size_t h = ((uint32_t)qx[i]*73856093u ^ (uint32_t)qy[i]*19349663u ^ (uint32_t)qz[i]*83492791u) & mask;
        for (;;) {
            int32_t s = table[h];
            if (s == -1) {
                table[h] = (int32_t)i;
                remap[i] = (uint32_t)(welded.size() / 3);
                welded.push_back(pos[i*3]); welded.push_back(pos[i*3+1]); welded.push_back(pos[i*3+2]);
                break;
            }
            if (qx[s]==qx[i] && qy[s]==qy[i] && qz[s]==qz[i]) { remap[i] = remap[s]; break; }
            h = (h + 1) & mask;
        }
    }
    for (auto& v : idx) v = remap[v];
    pos = std::move(welded);
}

// ═══════════════════════════════════════════════════════════════════════════
// [27/08] ARBRE CSG NATIF — support de POST /csgtree.
//
// RAISON D ETRE. Le Deep Re-run cote client (_deepRerunNode) ne produit pas
// une liste plate d operandes mais un ARBRE : chaque noeud est un booleen dont
// les enfants peuvent etre eux-memes des booleens. Jusqu ici cet arbre partait
// au Worker Manifold WASM (_workerCSGTree), seul chemin capable de garder les
// objets Manifold VIVANTS entre deux niveaux. Le deporter naivement sur /csg
// aurait impose un aller-retour HTTP par noeud, et surtout un cycle
// extract-meshgl -> re-weld -> reconstruction Manifold a CHAQUE niveau : sur un
// arbre a N noeuds internes, N-1 allers-retours ET N-1 reconstructions
// inutiles — exactement ce que la fusion cote WASM avait supprime.
//
// Ici le meme principe, en natif : l arbre entier arrive en UNE requete, est
// evalue en post-ordre, et les ManifoldManifold* intermediaires restent en
// memoire d un niveau au suivant. Un seul manifold_get_meshgl, a la racine.
//
// PROTOCOLE (little-endian, meme esprit binaire que /csg) :
//   [u32 magic 'CTRE' = 0x45525443][u32 version = 1] puis UN noeud recursif :
//   NOEUD = [u32 kind]
//     kind 0 (feuille)  : [u32 nVert][u32 nTri][f32 nVert*3][u32 nTri*3]
//     kind 1 (interne)  : [u32 opType 0=union/1=subtract/2=intersect]
//                         [u32 solidsCount][u32 childCount] puis childCount NOEUDs
//   solidsCount : nombre d enfants EN TETE a unioner entre eux pour former la
//   cible avant soustraction — meme semantique exacte que le champ du meme nom
//   dans /csg (le client reordonne les enfants solides-d abord quand hasMix).
// Reponse : STRICTEMENT le meme cadre que /csg (u32 jsonLen + JSON + positions
// f32 + indices u32) — le decodeur client est partage, rien a ecrire en plus.
// ═══════════════════════════════════════════════════════════════════════════
struct CsgTreeNode {
    bool leaf = true;
    std::vector<float>    pos;      // feuille uniquement
    std::vector<uint32_t> idx;      // feuille uniquement
    uint32_t opType = 0;            // noeud interne uniquement
    uint32_t solidsCount = 1;       // noeud interne uniquement
    std::vector<CsgTreeNode> children;
};

// Garde-fous de PARSING (pas des limites metier) : un arbre legitime issu de
// _buildTreePayload est borne par la profondeur d imbrication CSG reelle et par
// le nombre d objets de la scene. Ces bornes ne sont la que pour qu un u32
// corrompu ne fasse pas exploser la pile ni allouer a l infini — meme role que
// le "operandCount > bodySize/8" de /csg.
static const uint32_t CSGTREE_MAX_DEPTH = 256;
static const uint32_t CSGTREE_MAX_NODES = 1000000;

static void weldMeshForCSG(std::vector<float>& pos, std::vector<uint32_t>& idx) {
    if (weldLegacyForced()) { weldMeshForCSGLegacy(pos, idx); return; }
    weldMeshByProximity(pos, idx);
}

static void parseCsgTreeNode(const std::string& b, size_t& off, CsgTreeNode& out,
                             uint32_t depth, uint32_t& nodeCount, uint32_t& leafCount) {
    if (depth > CSGTREE_MAX_DEPTH) throw std::runtime_error("/csgtree: tree deeper than 256 levels (corrupt payload?)");
    if (++nodeCount > CSGTREE_MAX_NODES) throw std::runtime_error("/csgtree: node count out of bounds (corrupt payload?)");
    auto rdU32 = [&]()->uint32_t{
        if (off + 4 > b.size()) throw std::runtime_error("/csgtree: out-of-bounds read");
        uint32_t v; std::memcpy(&v, b.data()+off, 4); off += 4; return v;
    };
    uint32_t kind = rdU32();
    if (kind == 0) {
        leafCount++;
        out.leaf = true;
        uint32_t nVert = rdU32(), nTri = rdU32();
        size_t vBytes = (size_t)nVert * 3 * 4, iBytes = (size_t)nTri * 3 * 4;
        if (off + vBytes + iBytes > b.size()) throw std::runtime_error("/csgtree: truncated leaf mesh");
        const float* vp = reinterpret_cast<const float*>(b.data() + off); off += vBytes;
        const uint32_t* ip = reinterpret_cast<const uint32_t*>(b.data() + off); off += iBytes;
        out.pos.assign(vp, vp + (size_t)nVert * 3);
        out.idx.assign(ip, ip + (size_t)nTri * 3);
        return;
    }
    if (kind != 1) throw std::runtime_error("/csgtree: unknown node kind (corrupt payload?)");
    out.leaf = false;
    out.opType = rdU32();
    if (out.opType > 2) throw std::runtime_error("/csgtree: invalid opType");
    out.solidsCount = rdU32();
    uint32_t childCount = rdU32();
    if (childCount < 1) throw std::runtime_error("/csgtree: internal node with no child");
    // Chaque enfant occupe au minimum 4 octets (son champ kind) : un childCount
    // superieur au reste du corps est forcement un u32 corrompu.
    if ((size_t)childCount > (b.size() - off) / 4 + 1) throw std::runtime_error("/csgtree: childCount inconsistent with request size");
    if (out.opType == 1 && childCount >= 2 && (out.solidsCount < 1 || out.solidsCount >= childCount))
        throw std::runtime_error("/csgtree: invalid solidsCount for subtract (must be in [1, childCount-1])");
    out.children.resize(childCount);
    for (uint32_t i = 0; i < childCount; i++)
        parseCsgTreeNode(b, off, out.children[i], depth + 1, nodeCount, leafCount);
}

// Collecte a plat les feuilles (pointeurs dans l arbre) — permet de souder en
// parallele avant toute construction Manifold. La soudure est du C++ pur sur
// des buffers disjoints : parallelisable sans partage d etat. La construction
// Manifold elle-meme reste sequentielle (comme dans /csg), et le parallelisme
// des booleens vient de manifold_batch_boolean (TBB interne, MANIFOLD_PAR=1) —
// pas de threads imbriques, pas de sur-souscription.
static void collectCsgTreeLeaves(CsgTreeNode& n, std::vector<CsgTreeNode*>& out) {
    if (n.leaf) { out.push_back(&n); return; }
    for (auto& c : n.children) collectCsgTreeLeaves(c, out);
}

// ─────────────────────────────────────────────────────────────────────────
// [01/09] ManifoldArena — proprietaire unique des buffers Manifold d'une
// requete. Remplace les std::vector<void*> + boucles de free() manuelles, qui
// avaient deux defauts distincts :
//
//  (1) FUITE SUR CHEMIN D'ERREUR. Les free() etaient les dernieres instructions
//      DANS le try. Toute exception levee avant eux les sautait et abandonnait
//      l'arene entiere. Un destructeur, lui, s'execute pendant le depilage : il
//      n'existe plus de sortie de bloc sans liberation.
//
//  (2) DESTRUCTEUR JAMAIS APPELE — et celui-la fuyait AUSSI en cas de succes.
//      L'API C construit par placement (manifoldc.cpp : new (mem) Manifold(m)),
//      donc free(mem) rend la coquille mais n'execute pas ~Manifold() : les
//      vecteurs internes (positions, index, halfedges) restaient alloues. Le
//      plus couteux etait memOut : manifold_get_meshgl() COPIE tout le maillage
//      resultat dans un MeshGL, dont on ne relachait que l'enveloppe — soit la
//      taille du resultat perdue a chaque /csg reussi. manifold_destruct_*()
//      existe exactement pour ca (manifoldc.cpp:1104, from_c(m)->~Manifold())
//      et n'etait appele nulle part dans ce fichier.
//
// L'ORDRE COMPTE. Construction d'abord, prise de propriete ENSUITE. Un
// constructeur qui leve — manifold_of_meshgl() fait une copie de Manifold, donc
// il le peut — laisserait sinon dans l'arene un buffer non construit, sur
// lequel ~Manifold() irait dereferencer des pointeurs au hasard : on aurait
// troque une fuite contre un plantage. make() impose cet ordre par
// construction : le buffer est d'abord enregistre en BRUT (free seul, toujours
// sur), et n'est arme du bon destructeur qu'au retour du constructeur.
//
// Le destructeur a appeler n'est pas choisi a la main : la surcharge de
// dtorFor() l'apparie au type de retour du constructeur, donc c'est le
// compilateur qui garantit qu'un ManifoldMeshGL ne recevra jamais
// ~Manifold(). Liberation en ordre inverse de creation.
class ManifoldArena {
public:
    ManifoldArena() = default;
    ManifoldArena(const ManifoldArena&)            = delete;
    ManifoldArena& operator=(const ManifoldArena&) = delete;
    ~ManifoldArena() { reset(); }

    // Buffer brut, sans destructeur : les tableaux de float/uint32 remplis par
    // manifold_meshgl_vert_properties() & co sont du POD, free() suffit.
    // [FIX] Reserve AVANT tout malloc : si slots_ levait bad_alloc en
    // s'agrandissant apres un malloc reussi, le tampon etait perdu. Croissance
    // geometrique conservee — reserve(size+1) aurait rendu l'insertion O(n^2).
    void _reserveOneMore() {
        if (slots_.size() == slots_.capacity())
            slots_.reserve(slots_.empty() ? 16 : slots_.size() * 2);
    }

    void* raw(size_t bytes) {
        _reserveOneMore();
        // bytes == 0 est LEGITIME ici : un resultat vide (subtract qui consomme
        // entierement la cible — cas explicitement journalise "isEmpty") demande
        // un tampon de zero octet, jamais lu ensuite. malloc(0) a le droit de
        // rendre NULL ; le refuser ferait echouer en 500 une requete valide.
        void* p = malloc(bytes);
        if (!p && bytes) throw std::bad_alloc();
        slots_.push_back(Slot{ p, nullptr });
        return p;
    }

    // Alloue `bytes`, appelle `ctor(buffer)`, prend possession du resultat.
    template <class Ctor>
    auto make(size_t bytes, Ctor ctor) -> decltype(ctor((void*)nullptr)) {
        _reserveOneMore();
        void* p = malloc(bytes);
        if (!p) throw std::bad_alloc();   // ici bytes = manifold_*_size(), jamais 0
        slots_.push_back(Slot{ p, nullptr });
        const size_t idx = slots_.size() - 1;
        auto* obj = ctor(p);           // peut lever : le slot reste "brut", donc
        slots_[idx].dtor = dtorFor(obj); // simplement free() — jamais ~T() sur du vide.
        return obj;
    }

    void reset() {
        for (size_t i = slots_.size(); i-- > 0; ) {
            if (slots_[i].dtor) slots_[i].dtor(slots_[i].p);
            free(slots_[i].p);   // free(NULL) est un no-op — cf. raw(0)
        }
        slots_.clear();
    }

private:
    typedef void (*DtorFn)(void*);
    struct Slot { void* p; DtorFn dtor; };
    std::vector<Slot> slots_;

    static void dtorManifold(void* p)    { manifold_destruct_manifold((ManifoldManifold*)p); }
    static void dtorManifoldVec(void* p) { manifold_destruct_manifold_vec((ManifoldManifoldVec*)p); }
    static void dtorMeshGL(void* p)      { manifold_destruct_meshgl((ManifoldMeshGL*)p); }

    static DtorFn dtorFor(ManifoldManifold*)    { return &dtorManifold; }
    static DtorFn dtorFor(ManifoldManifoldVec*) { return &dtorManifoldVec; }
    static DtorFn dtorFor(ManifoldMeshGL*)      { return &dtorMeshGL; }
};

// Evaluation post-ordre. Retourne un ManifoldManifold* dont la duree de vie est
// celle de `mem` (libere par l appelant en fin de requete). Les intermediaires
// ne sont JAMAIS extraits en meshgl : c est tout l interet de l endpoint.
static ManifoldManifold* evalCsgTreeNode(CsgTreeNode& n, ManifoldArena& mem) {
    if (n.leaf) {
        ManifoldMeshGL* mg = mem.make(manifold_meshgl_size(), [&](void* p){
            return manifold_meshgl(p, n.pos.data(), n.pos.size()/3, 3,
                                   n.idx.data(), n.idx.size()/3); });
        return mem.make(manifold_manifold_size(), [&](void* p){
            return manifold_of_meshgl(p, mg); });
    }

    std::vector<ManifoldManifold*> kids;
    kids.reserve(n.children.size());
    for (auto& c : n.children) kids.push_back(evalCsgTreeNode(c, mem));

    // Un seul enfant : rien a combiner, le noeud est transparent. Cas produit
    // par un sous-arbre dont les freres ont ete absorbes par le bypass
    // trivial-union cote client.
    if (kids.size() == 1) return kids[0];

    ManifoldOpType mop = n.opType == 0 ? MANIFOLD_ADD : n.opType == 1 ? MANIFOLD_SUBTRACT : MANIFOLD_INTERSECT;

    if (n.opType == 1) {
        // Subtract : non-commutatif, manifold_batch_boolean ne le supporte pas.
        // Meme identite ensembliste que dans /csg : (S1 u S2 u ..) - (H1 u H2 u ..).
        size_t sc = (size_t)n.solidsCount;
        if (sc < 1) sc = 1;
        if (sc >= kids.size()) sc = kids.size() - 1;
        ManifoldManifold* target;
        if (sc > 1) {
            ManifoldManifoldVec* solidVec = mem.make(manifold_manifold_vec_size(),
                [&](void* p){ return manifold_manifold_empty_vec(p); });
            for (size_t i = 0; i < sc; i++) manifold_manifold_vec_push_back(solidVec, kids[i]);
            target = mem.make(manifold_manifold_size(), [&](void* p){
                return manifold_batch_boolean(p, solidVec, MANIFOLD_ADD); });
        } else {
            target = kids[0];
        }
        ManifoldManifoldVec* subVec = mem.make(manifold_manifold_vec_size(),
            [&](void* p){ return manifold_manifold_empty_vec(p); });
        for (size_t i = sc; i < kids.size(); i++) manifold_manifold_vec_push_back(subVec, kids[i]);
        ManifoldManifold* subtrahends = mem.make(manifold_manifold_size(), [&](void* p){
            return manifold_batch_boolean(p, subVec, MANIFOLD_ADD); });
        return mem.make(manifold_manifold_size(), [&](void* p){
            return manifold_boolean(p, target, subtrahends, MANIFOLD_SUBTRACT); });
    }

    // Union / Intersect : commutatifs -> batch natif (tri par taille + TBB).
    ManifoldManifoldVec* vec = mem.make(manifold_manifold_vec_size(),
        [&](void* p){ return manifold_manifold_empty_vec(p); });
    for (auto* k : kids) manifold_manifold_vec_push_back(vec, k);
    return mem.make(manifold_manifold_size(), [&](void* p){
        return manifold_batch_boolean(p, vec, mop); });
}

// ─────────────────────────────────────────────────────────────────────────
// [31/08] Mode "--selftest-colors" — banc d'essai de decideBodyColor().
//
//     ./nasscad_medusa --selftest-colors
//
// Ni fichier, ni document XCAF, ni serveur : quelques millisecondes, et ca dit
// si un remaniement a casse la table de decision couleur. Les cas ne sont pas
// inventes — ce sont les configurations reellement relevees dans
// Scania-Engine-V8-XT-Turbo.step par lecture directe du Part21 :
//   15 176 STYLED_ITEM, dont 14 921 sur des ADVANCED_FACE et 254 sur des
//   solides ; 98 corps sur 254 avec une couleur de solide en contradiction
//   avec celle de leurs faces, dont 53 en jaune #DDDD0D — le jaune vif observe
//   a l'ecran et absent de FreeCAD.
//
// Le premier cas verifie aussi l'aller-retour sRGB d'occtColorToSRGB : si un
// jour quelqu'un remplace la courbe par un gamma maison, il tombe ici.
// ─────────────────────────────────────────────────────────────────────────
static std::string colorToHex(const Quantity_Color& c) {
    double v[3];
    occtColorToSRGB(c, v[0], v[1], v[2]);
    static const char* H = "0123456789ABCDEF";
    std::string s = "#";
    for (int i = 0; i < 3; i++) {
        int n = (int)std::lround(v[i] * 255.0);
        if (n < 0) n = 0;
        if (n > 255) n = 255;
        s += H[n >> 4];
        s += H[n & 15];
    }
    return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// [21/09 — Nass] BANC D'ESSAI DE LA COUTURE — `--selftest-weld`
// ═══════════════════════════════════════════════════════════════════════════
// Une reparation non mesuree n'est pas une reparation. Ce banc ne verifie pas
// « ca a l'air mieux » : il pose des cas ou la reponse exacte est connue et
// compare. Trois familles de pieges, choisies pour ce qu'elles cassent :
//
//   - le CYLINDRE et le TORE ont une couture de surface periodique (seam) :
//     les deux bords de la nappe sont geometriquement confondus et doivent
//     etre recousus, sinon on obtient deux chaines d'aretes nues.
//   - le CONE (r2=0) et la SPHERE ont des aretes DEGENEREES : un apex, deux
//     poles. La ou une soudure naive laisse un eventail de doublons, la
//     couture doit produire UN point singulier.
//   - le CYLINDRE PLACE A 1400 mm rejoue le defaut de production : prototype
//     maille a l'origine, instance placee loin. C'est la que le pas du float32
//     (~1,2e-4 a cette distance) depasse la tolerance de weldMeshLocal (1e-4)
//     et que la soudure par proximite cesse silencieusement de souder.
//
// Pour chacun : 0 arete nue, 0 arete sur-valencee, 0 sommet papillon, et le
// volume du MAILLAGE compare au volume EXACT du B-Rep (BRepGProp) — c'est le
// meme controle que les geometric validation properties d'AP242, applique
// ici a l'echelle d'une piece. Le volume signe verifie en prime l'orientation :
// negatif = normales rentrantes.
//
// La ligne « legacy » n'est pas un echec : elle montre ce que produisait
// l'ancien chemin sur le meme cas, pour que le gain soit lisible.
// ═══════════════════════════════════════════════════════════════════════════
static int runWeldSelfTestCli() {
    auto pad = [](std::string s, size_t n) { while (s.size() < n) s += ' '; return s; };

    // Volume signe d'une soupe indexee (theoreme de la divergence, un terme par
    // triangle). Positif si les normales sortent.
    auto meshVolume = [](const MeshData& m) -> double {
        double v = 0.0;
        for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
            const uint32_t i0 = m.indices[t], i1 = m.indices[t+1], i2 = m.indices[t+2];
            const double ax = m.positions[(size_t)i0*3],   ay = m.positions[(size_t)i0*3+1], az = m.positions[(size_t)i0*3+2];
            const double bx = m.positions[(size_t)i1*3],   by = m.positions[(size_t)i1*3+1], bz = m.positions[(size_t)i1*3+2];
            const double cx = m.positions[(size_t)i2*3],   cy = m.positions[(size_t)i2*3+1], cz = m.positions[(size_t)i2*3+2];
            // a . (b x c) / 6
            v += (ax * (by*cz - bz*cy) - ay * (bx*cz - bz*cx) + az * (bx*cy - by*cx)) / 6.0;
        }
        return v;
    };

    // [FIX 27/09] `drop` : face dont on RETIRE la triangulation apres maillage,
    // pour rejouer l'echec de BRepMesh et exercer l'etage A' (remplissage depuis
    // les voisines). 0 = aucune, 1 = premiere face non plane, 2 = la face qui a
    // le plus de fils (celle qui porte les trous).
    struct Case { std::string name; TopoDS_Shape shape; double defl; int drop = 0; };
    std::vector<Case> cases;
    {
        const TopoDS_Shape cyl = BRepPrimAPI_MakeCylinder(5.0, 20.0).Shape();
        // `Moved` garde le MEME TShape : le prototype est maille une fois, et
        // l'instance placee relit la meme triangulation. C'est exactement le
        // chemin de production (cf. tessellateShapeImpl), donc exactement le
        // chemin qu'il faut tester.
        gp_Trsf away;
        away.SetTranslation(gp_Vec(1400.0, 650.0, -900.0)); // surtout pas `far` : macro windows.h
        cases.push_back({ "box 10x20x30",                 BRepPrimAPI_MakeBox(10.0, 20.0, 30.0).Shape(), 0.05 });
        cases.push_back({ "cylinder r5 h20 (seam)",       cyl,                                           0.02 });
        cases.push_back({ "cylinder r5 h20 @1400mm",      cyl.Moved(TopLoc_Location(away)),              0.02 });
        cases.push_back({ "cone r8->0 h15 (apex degen)",  BRepPrimAPI_MakeCone(8.0, 0.0, 15.0).Shape(),  0.02 });
        cases.push_back({ "sphere r7 (2 poles + seam)",   BRepPrimAPI_MakeSphere(7.0).Shape(),           0.02 });
        cases.push_back({ "torus R20 r4 (2 seams)",       BRepPrimAPI_MakeTorus(20.0, 4.0).Shape(),      0.02 });
        // [FIX 27/09] Faces non maillees, remplies depuis leur bord. Le cylindre
        // est le piege d'un critere de lamelle par aire projetee : son contour
        // parcourt deux cercles en sens opposes, aire de Newell nulle.
        cases.push_back({ "cylinder, lateral face unmeshed", BRepPrimAPI_MakeCylinder(5.0, 20.0).Shape(), 0.02, 1 });
        cases.push_back({ "cone r8->3, lateral unmeshed",    BRepPrimAPI_MakeCone(8.0, 3.0, 15.0).Shape(), 0.02, 1 });
        {
            TopoDS_Shape plate = BRepPrimAPI_MakeBox(60.0, 30.0, 5.0).Shape();
            gp_Ax2 a1(gp_Pnt(15.0, 15.0, -1.0), gp_Dir(0, 0, 1)), a2(gp_Pnt(45.0, 15.0, -1.0), gp_Dir(0, 0, 1));
            plate = BRepAlgoAPI_Cut(plate, BRepPrimAPI_MakeCylinder(a1, 6.0, 7.0).Shape()).Shape();
            plate = BRepAlgoAPI_Cut(plate, BRepPrimAPI_MakeCylinder(a2, 4.0, 7.0).Shape()).Shape();
            cases.push_back({ "plate 2 holes, pierced face unmeshed", plate, 0.02, 2 });
        }
    }

    int fails = 0;
    std::cout << "\n[selftest-weld] topological seam welding — "
              << (topoWeldEnabled() ? "ENABLED" : "DISABLED (NASSCAD_TOPOWELD=0)")
              << "\n\n";

    for (Case& c : cases) {
        // Maillage du PROTOTYPE, comme en production.
        const TopoDS_Shape proto = c.shape.Located(TopLoc_Location());
        IMeshTools_Parameters mp;
        mp.Deflection = c.defl;
        mp.Angle      = ANGULAR_DEFLECTION;
        mp.Relative   = Standard_False;
        mp.InParallel = Standard_True;
        try {
            BRepMesh_IncrementalMesh mesher(proto, mp, Message_ProgressRange());
        } catch (const std::exception& e) {
            std::cout << "FAIL " << pad(c.name, 34) << " meshing failed: " << e.what() << "\n";
            fails++; continue;
        }
        if (c.drop) {
            TopoDS_Face victim;
            int bestWires = -1;
            for (TopExp_Explorer fe(proto, TopAbs_FACE); fe.More(); fe.Next()) {
                const TopoDS_Face f = TopoDS::Face(fe.Current());
                if (c.drop == 1) {
                    if (BRepAdaptor_Surface(f).GetType() != GeomAbs_Plane) { victim = f; break; }
                } else {
                    int nw = 0;
                    for (TopExp_Explorer we(f, TopAbs_WIRE); we.More(); we.Next()) nw++;
                    if (nw > bestWires) { bestWires = nw; victim = f; }
                }
            }
            if (!victim.IsNull()) BRep_Builder().UpdateFace(victim, Handle(Poly_Triangulation)());
        }

        // Volume exact du B-Rep — la reference.
        double vExact = 0.0;
        try {
            GProp_GProps props;
            BRepGProp::VolumeProperties(c.shape, props);
            vExact = props.Mass();
        } catch (const std::exception&) { vExact = 0.0; }

        std::vector<MeshData> outTopo, outLegacy;
        bool usable = false;
        extractIntoTopo(c.shape, c.name, std::nullopt, outTopo, nullptr, 1.0f, usable);
        extractIntoLegacy(c.shape, c.name, std::nullopt, outLegacy, nullptr, 1.0f);

        if (!usable || outTopo.empty()) {
            std::cout << "FAIL " << pad(c.name, 34) << " seam data unusable\n";
            fails++; continue;
        }
        const MeshData& mt = outTopo.front();
        int nk = 0, ov = 0, bt = 0;
        nasweld::analyzeTopology(mt.indices, (uint32_t)(mt.positions.size() / 3), nk, ov, bt);
        const double vMesh = meshVolume(mt);
        const double relErr = (vExact > 0.0) ? std::fabs(vMesh - vExact) / vExact : 0.0;

        // Seuils : la topologie est EXACTE (0 tolere), le volume est approche
        // par construction (tessellation a deflexion finie) — 2 % laisse passer
        // l'erreur de discretisation et arrete tout le reste.
        const bool okTopo = (nk == 0 && ov == 0 && bt == 0);
        const bool okVol  = (vExact <= 0.0) || (relErr < 0.02 && vMesh > 0.0);
        const bool ok = okTopo && okVol;
        if (!ok) fails++;

        std::cout << (ok ? " ok  " : "FAIL ") << pad(c.name, 34)
                  << " tris=" << pad(std::to_string(mt.indices.size() / 3), 7)
                  << " verts=" << pad(std::to_string(mt.positions.size() / 3), 7)
                  << " naked=" << pad(std::to_string(nk), 5)
                  << " over=" << pad(std::to_string(ov), 4)
                  << " bowtie=" << pad(std::to_string(bt), 4);
        if (vExact > 0.0) {
            std::ostringstream vo;
            vo.setf(std::ios::fixed); vo.precision(3);
            vo << "vol " << (100.0 * relErr) << "%";
            std::cout << " " << vo.str();
            if (vMesh <= 0.0) std::cout << " (NEGATIVE VOLUME — inward normals)";
        }
        if (!outLegacy.empty()) {
            int lk = 0, lo = 0, lb = 0;
            nasweld::analyzeTopology(outLegacy.front().indices,
                                     (uint32_t)(outLegacy.front().positions.size() / 3), lk, lo, lb);
            std::cout << "   [legacy: naked=" << lk << " verts="
                      << (outLegacy.front().positions.size() / 3) << "]";
        }
        std::cout << "\n";
        if (!ok && vExact > 0.0)
            std::cout << "        mesh volume=" << vMesh << " exact=" << vExact << "\n";
    }

    std::cout << "\n[selftest-weld] " << (fails ? "FAILED" : "OK")
              << " — " << cases.size() << " case(s), " << fails << " failure(s)\n\n";
    return fails ? 1 : 0;
}

static int runColorSelfTestCli() {
    const Quantity_Color JAUNE (0.866667, 0.866667, 0.050980, Quantity_TOC_sRGB); // #DDDD0D
    const Quantity_Color GRIS  (0.352941, 0.384314, 0.400000, Quantity_TOC_sRGB); // #5A6266
    const Quantity_Color ORANGE(0.811765, 0.309804, 0.000000, Quantity_TOC_sRGB); // #CF4F00

    int fails = 0;
    auto pad = [](std::string s, size_t n) { while (s.size() < n) s += ' '; return s; };

    auto scanOf = [](size_t nFaces, size_t nStyled, bool uniform,
                     std::optional<Quantity_Color> first) {
        FaceScan s;
        s.nFaces = nFaces; s.nStyled = nStyled; s.uniform = uniform; s.first = first;
        if (nStyled) s.map = std::make_shared<FaceColorMap>();
        return s;
    };
    auto check = [&](const char* nom, const ColorDecision& d,
                     const char* attCol, bool attMap, const char* attPath) {
        std::string got = d.col ? colorToHex(*d.col) : "(none)";
        bool ok = got == attCol && d.useFaceMap == attMap && std::string(d.path) == attPath;
        if (!ok) fails++;
        std::cout << (ok ? " ok  " : "FAIL ") << pad(nom, 46)
                  << " colour=" << pad(got, 9)
                  << " map=" << (d.useFaceMap ? "yes" : "no")
                  << " path=" << d.path << "\n";
        if (!ok) std::cout << "        expected : colour=" << attCol
                           << " map=" << (attMap ? "yes" : "no")
                           << " path=" << attPath << "\n";
    };

    std::cout << "\n[selftest] sRGB round-trip (occtColorToSRGB)\n";
    for (auto& p : { std::make_pair(&JAUNE, "#DDDD0D"), std::make_pair(&GRIS, "#5A6266"),
                     std::make_pair(&ORANGE, "#CF4F00") }) {
        std::string got = colorToHex(*p.first);
        bool ok = got == p.second;
        if (!ok) fails++;
        std::cout << (ok ? " ok  " : "FAIL ") << pad(got, 9) << " expected " << p.second << "\n";
    }

    std::cout << "\n[selftest] decision table (decideBodyColor)\n";
    const char* LBL = "label-inst-Surf";

    check("no styled face, yellow solid",
          decideBodyColor(scanOf(3, 0, true, {}), JAUNE, LBL),
          "#DDDD0D", false, LBL);

    // LE cas du bug : brep#3328 — 649 faces grises sous un solide jaune.
    check("all faces grey, yellow solid (the bug)",
          decideBodyColor(scanOf(649, 649, true, GRIS), JAUNE, LBL),
          "#5A6266", false, "face-uniform-override");

    // brep#2950 — 1751 faces orange + 22 autres, solide jaune : multicolore.
    check("faces orange+grey, yellow solid (brep#2950)",
          decideBodyColor(scanOf(1773, 1773, false, ORANGE), JAUNE, LBL),
          "#DDDD0D", true, LBL);

    // Une seule face stylee parmi 500 nues : la carte doit survivre.
    check("1 grey face / 500 bare, yellow solid",
          decideBodyColor(scanOf(500, 1, true, GRIS), JAUNE, LBL),
          "#DDDD0D", true, LBL);

    check("no solid colour, uniform faces",
          decideBodyColor(scanOf(12, 12, true, ORANGE), {}, "none"),
          "#CF4F00", false, "face-uniform");

    // Cas PCB (Stealthburner, valide le 13/08) : le label parent n'a pas de
    // couleur, chaque sous-solide porte la sienne. Comportement d'avant, intact.
    check("no solid colour, mixed faces (PCB)",
          decideBodyColor(scanOf(10, 10, false, ORANGE), {}, "none"),
          "#CF4F00", true, "face-first");

    check("no colour anywhere",
          decideBodyColor(scanOf(2, 0, true, {}), {}, "none"),
          "(none)", false, "none");

    // Surcharge d'instance : meme prototype, couleur d'instance differente.
    // La regle des faces uniformes doit gagner dans les deux cas.
    check("instance override + uniform faces",
          decideBodyColor(scanOf(30, 30, true, GRIS), ORANGE, LBL),
          "#5A6266", false, "face-uniform-override");

    std::cout << "\n" << (fails ? "FAILED" : "ALL PASS") << " — " << fails << " failure(s)\n\n";
    return fails ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// [17/09] Reglages passes dans l'URL — un balayage de k ne demande plus de
// redemarrer le serveur entre deux mesures, ce qui etait la seule raison pour
// laquelle personne ne l'avait fait.
//   ?deflection=<mm>   deflexion FORCEE pour cette requete (prioritaire sur tout)
//   ?k=<0..1>          coefficient de silhouette de la deflexion adaptative
//   ?budget=<n>        budget de triangles par corps (0 = garde-fou desactive)
// Le serveur traite les requetes sequentiellement (boucle mono-thread, cf. son
// commentaire), et ces globales ne sont lues que pendant la requete en cours :
// exactement le contrat sous lequel gDeflectionOverride fonctionne depuis
// l'origine. Les cles sont comparees ENTIERES (decoupage sur '&' puis '='),
// et non cherchees comme sous-chaines : "k=" se serait sinon reconnu dans
// n'importe quelle cle finissant par k.
// Retourne la deflexion forcee, ou -1 si absente.
static double parseQueryTuning(const std::string& path) {
    double deflection = -1.0;
    const auto qpos = path.find('?');
    if (qpos == std::string::npos) return deflection;
    const std::string q = path.substr(qpos + 1);
    size_t pos = 0;
    while (pos < q.size()) {
        const size_t amp = q.find('&', pos);
        const std::string kv = q.substr(pos, (amp == std::string::npos) ? std::string::npos : amp - pos);
        pos = (amp == std::string::npos) ? q.size() : amp + 1;
        const size_t eq = kv.find('=');
        if (eq == std::string::npos) continue;
        const std::string key = kv.substr(0, eq);
        double v = 0.0;
        try { v = std::stod(kv.substr(eq + 1)); } catch (...) { continue; }
        if (key == "deflection") {
            deflection = v;
        } else if (key == "deviation" && v > 0.0 && v < 100.0) {
            // En POURCENTS, comme la propriete Deviation de FreeCAD.
            gDeviation = v / 100.0;
            std::cerr << cInfo() << "[INFO]" << cReset() << " deviation = " << v << "% (URL)\n";
        } else if (key == "k" && v > 0.0 && v < 1.0) {
            // Alias historique, en RATIO (0.005 = 0,5 %).
            gDeviation = v;
            std::cerr << cInfo() << "[INFO]" << cReset() << " deviation = " << (v * 100.0)
                      << "% (URL, alias k)\n";
        } else if (key == "budget" && v >= 0.0) {
            gTriBudgetPerBody = (long long)v;
            std::cerr << cInfo() << "[INFO]" << cReset() << " triangle budget/body = "
                      << gTriBudgetPerBody << " (URL)\n";
        }
    }
    return deflection;
}

// ═════════════════════════════════════════════════════════════════════════════
// [24/09] BANC D'ESSAI DE L'EXPORT STEP NATIF — `--selftest-stepexport`
//
// OCCT sert de juge : on fabrique des pieces a reponse connue, on les passe par
// EXACTEMENT le chemin de /stepexport (meme requete NSX1, meme stepx::exportStep),
// puis STEPCAFControl_Reader relit le texte produit. Pour AP203, AP214, AP242 :
//   - integrite Part 21 : chaque #id defini une seule fois, chaque reference
//     resolue, aucune ligne > 256 caracteres (c'est la que casserait
//     l'arithmetique des #id de l'ecriture parallele) ;
//   - volume de chaque solide relu (BRepGProp) contre la valeur attendue ;
//   - nature des representations : solide / coque ouverte ;
//   - noms (Unicode compris, \X2\) et couleurs de corps ET par face relus
//     via XCAFDoc_ColorTool.
// Aucun fichier, aucune socket : quelques centaines de millisecondes.
// ═════════════════════════════════════════════════════════════════════════════
namespace stepxtest {

struct Mesh { std::vector<float> pos; std::vector<uint32_t> idx; std::vector<int32_t> mat; };

// Maillage OCCT d'une forme -> triangles (repere de la forme, sens corrige par
// l'orientation de la face). Sert de « corps NASSCAD » pour le banc.
static Mesh meshOf(const TopoDS_Shape& s, double defl) {
    BRepMesh_IncrementalMesh(s, defl, Standard_False, 0.2, Standard_False);
    Mesh m;
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face f = TopoDS::Face(ex.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(f, loc);
        if (tri.IsNull()) continue;
        const uint32_t v0 = (uint32_t)(m.pos.size() / 3);
        for (int i = 1; i <= tri->NbNodes(); i++) {
            const gp_Pnt p = tri->Node(i).Transformed(loc.Transformation());
            m.pos.push_back((float)p.X()); m.pos.push_back((float)p.Y()); m.pos.push_back((float)p.Z());
        }
        const bool rev = f.Orientation() == TopAbs_REVERSED;
        for (int i = 1; i <= tri->NbTriangles(); i++) {
            int a, b, c; tri->Triangle(i).Get(a, b, c);
            if (rev) std::swap(b, c);
            m.idx.push_back(v0 + a - 1); m.idx.push_back(v0 + b - 1); m.idx.push_back(v0 + c - 1);
        }
    }
    return m;
}
// Volume signe d'un maillage ferme (theoreme de la divergence).
static double meshVolume(const Mesh& m) {
    double v = 0;
    for (size_t t = 0; t + 2 < m.idx.size(); t += 3) {
        const float* a = &m.pos[m.idx[t] * 3]; const float* b = &m.pos[m.idx[t+1] * 3]; const float* c = &m.pos[m.idx[t+2] * 3];
        v += (double)a[0] * ((double)b[1] * c[2] - (double)b[2] * c[1])
           - (double)a[1] * ((double)b[0] * c[2] - (double)b[2] * c[0])
           + (double)a[2] * ((double)b[0] * c[1] - (double)b[1] * c[0]);
    }
    return v / 6.0;
}
static Mesh toSoup(const Mesh& m) {
    Mesh s;
    for (uint32_t i : m.idx) { s.pos.push_back(m.pos[i*3]); s.pos.push_back(m.pos[i*3+1]); s.pos.push_back(m.pos[i*3+2]); }
    s.mat = m.mat;
    return s;
}

struct Req {
    std::string b;
    uint32_t count = 0; size_t countOff = 0;
    void u32(uint32_t v) { b.append((const char*)&v, 4); }
    void f64(double v) { b.append((const char*)&v, 8); }
    void str(const std::string& s) { u32((uint32_t)s.size()); b += s; while (b.size() % 4) b += '\0'; }
    Req(int ap, int mode, int keyDec, double tol) {
        b = "NSX1"; u32((uint32_t)ap); u32((uint32_t)mode); u32((uint32_t)keyDec); f64(tol);
        u32(0); str("selftest"); countOff = b.size(); u32(0);
    }
    void head(uint32_t kind, const std::string& name, uint32_t rgb, double a, const std::vector<std::pair<uint32_t,double>>& pal) {
        u32(kind); str(name); u32(rgb); f64(a); u32((uint32_t)pal.size());
        for (auto& p : pal) { u32(p.first); f64(p.second); }
        count++; std::memcpy(&b[countOff], &count, 4);
    }
    void mesh(const std::string& name, const Mesh& m, uint32_t rgb, double a = 1.0,
              const std::vector<std::pair<uint32_t,double>>& pal = {}) {
        head(0, name, rgb, a, pal);
        const bool indexed = !m.idx.empty();
        const uint32_t nV = (uint32_t)(m.pos.size() / 3), nT = indexed ? (uint32_t)(m.idx.size() / 3) : nV / 3;
        u32(nV); u32(nT); u32((indexed ? 1u : 0u) | (m.mat.empty() ? 0u : 2u));
        b.append((const char*)m.pos.data(), m.pos.size() * 4);
        if (indexed) b.append((const char*)m.idx.data(), m.idx.size() * 4);
        if (!m.mat.empty()) b.append((const char*)m.mat.data(), m.mat.size() * 4);
    }
    void sphere(const std::string& name, double x, double y, double z, double r, uint32_t rgb) {
        head(1, name, rgb, 1.0, {}); f64(x); f64(y); f64(z); f64(r);
    }
};

// Integrite Part 21 : ids uniques et continus, references resolues, lignes <= 256.
static bool checkPart21(const std::string& txt, std::string& why) {
    std::unordered_set<uint64_t> defs; std::vector<uint64_t> refs;
    size_t pos = 0, maxLine = 0; bool inData = false;
    std::string ent;
    auto flushEnt = [&]() -> bool {
        if (ent.empty()) return true;
        size_t k = 1; uint64_t id = 0;
        while (k < ent.size() && std::isdigit((unsigned char)ent[k])) id = id * 10 + (ent[k++] - '0');
        if (!defs.insert(id).second) { why = "duplicate #" + std::to_string(id); return false; }
        bool q = false;
        for (; k < ent.size(); k++) {
            const char c = ent[k];
            if (c == '\'') q = !q;
            else if (!q && c == '#') {
                uint64_t r = 0; size_t j = k + 1;
                while (j < ent.size() && std::isdigit((unsigned char)ent[j])) r = r * 10 + (ent[j++] - '0');
                refs.push_back(r);
            }
        }
        ent.clear(); return true;
    };
    while (pos < txt.size()) {
        size_t e = txt.find('\n', pos); if (e == std::string::npos) e = txt.size();
        const std::string line = txt.substr(pos, e - pos); pos = e + 1;
        maxLine = std::max(maxLine, line.size());
        if (line == "DATA;") { inData = true; continue; }
        if (!inData || line.rfind("/*", 0) == 0) continue;
        if (line == "ENDSEC;") { if (!flushEnt()) return false; inData = false; continue; }
        if (!line.empty() && line[0] == '#') { if (!flushEnt()) return false; ent = line; }
        else ent += line;
    }
    if (!flushEnt()) return false;
    if (maxLine > 256) { why = "line of " + std::to_string(maxLine) + " characters"; return false; }
    for (uint64_t i = 1; i <= defs.size(); i++) if (!defs.count(i)) { why = "id gap at #" + std::to_string(i); return false; }
    for (uint64_t r : refs) if (!defs.count(r)) { why = "dangling reference #" + std::to_string(r); return false; }
    return true;
}

// kind : representation attendue pour ce corps (vide = pas de controle, cas
// limite ou le choix taille/representation peut legitimement basculer).
struct Expect { std::string name; double vol; bool solid; uint32_t rgb; size_t faceOverrides; std::string kind = ""; };

// Un solide TESSELE n'a que des triangulations, pas de surfaces : son volume
// se calcule sur le maillage (BRepGProp, UseTriangulation). Un B-Rep exact
// garde le calcul sur les surfaces.
static double volumeOf(const TopoDS_Shape& s) {
    bool meshOnly = false;
    for (TopExp_Explorer x(s, TopAbs_FACE); x.More() && !meshOnly; x.Next()) {
        TopLoc_Location l;
        if (BRep_Tool::Surface(TopoDS::Face(x.Current()), l).IsNull()) meshOnly = true;
    }
    GProp_GProps g;
    BRepGProp::VolumeProperties(s, g, Standard_False, Standard_False, meshOnly ? Standard_True : Standard_False);
    return std::fabs(g.Mass());
}

static std::string extToUtf8(const TCollection_ExtendedString& s) {
    std::string o;
    for (int i = 1; i <= s.Length(); i++) {
        uint32_t c = s.Value(i);
        if (c >= 0xD800 && c <= 0xDBFF && i < s.Length()) {
            const uint32_t d = s.Value(i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
        }
        if (c < 0x80) o += (char)c;
        else if (c < 0x800) { o += (char)(0xC0 | (c >> 6)); o += (char)(0x80 | (c & 63)); }
        else if (c < 0x10000) { o += (char)(0xE0 | (c >> 12)); o += (char)(0x80 | ((c >> 6) & 63)); o += (char)(0x80 | (c & 63)); }
        else { o += (char)(0xF0 | (c >> 18)); o += (char)(0x80 | ((c >> 12) & 63)); o += (char)(0x80 | ((c >> 6) & 63)); o += (char)(0x80 | (c & 63)); }
    }
    return o;
}

static int runOne(const char* label, Req& rq, const std::vector<Expect>& ex, int& fails) {
    stepx::Stats st;
    const std::string txt = stepx::exportStepToString(rq.b, st);
    std::string why;
    auto bad = [&](const std::string& m) { std::cerr << cErr() << "  FAIL" << cReset() << " [" << label << "] " << m << "\n"; fails++; };
    if (!checkPart21(txt, why)) { bad("Part 21 integrity: " + why); return 1; }
    for (const Expect& e : ex)
        if (!e.kind.empty() && txt.find(e.kind + "('" + stepx::stepStr(e.name) + "'") == std::string::npos)
            bad("'" + e.name + "': not written as " + e.kind);
#if OCC_VERSION_HEX < 0x070700
    // OCCT < 7.7 ne lit pas les entites tesselees AP242 : relecture impossible.
    if (txt.find("TESSELLATED_S") != std::string::npos) {
        std::cerr << cWarn() << "  " << label << cReset() << " : tessellated bodies written ("
                  << st.nTess << "), re-read SKIPPED — OCCT " OCC_VERSION_COMPLETE " cannot read AP242 tessellated geometry (7.7+ required)\n";
        return 0;
    }
#endif

    Handle(TDocStd_Document) doc;
    XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
    STEPCAFControl_Reader caf; caf.SetColorMode(true); caf.SetNameMode(true);
    std::istringstream is(txt);
    if (caf.ChangeReader().ReadStream("selftest.step", is) != IFSelect_RetDone) { bad("OCCT could not parse the file"); return 1; }
    if (!caf.Transfer(doc)) { bad("OCCT transfer failed"); return 1; }
    Handle(XCAFDoc_ShapeTool) stool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) ctool = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    TDF_LabelSequence all; stool->GetShapes(all);
    size_t matched = 0;
    for (const Expect& e : ex) {
        bool found = false;
        for (int i = 1; i <= all.Length(); i++) {
            const TDF_Label L = all.Value(i);
            if (stool->IsAssembly(L)) continue;
            Handle(TDataStd_Name) nm;
            if (!L.FindAttribute(TDataStd_Name::GetID(), nm)) continue;
            if (extToUtf8(nm->Get()) != e.name) continue;
            found = true; matched++;
            const TopoDS_Shape s = stool->GetShape(L);
            int nSol = 0; for (TopExp_Explorer x(s, TopAbs_SOLID); x.More(); x.Next()) nSol++;
            if (e.solid != (nSol > 0)) bad("'" + e.name + "': expected " + (e.solid ? "a solid" : "an open shell") + ", got " + std::to_string(nSol) + " solid(s)");
            if (e.solid) {
                const double v = volumeOf(s);
                if (std::fabs(v - e.vol) > 1e-3 * std::max(1.0, e.vol))
                    bad("'" + e.name + "': volume " + std::to_string(v) + ", expected " + std::to_string(e.vol));
            }
            Quantity_Color c;
            bool hasC = ctool->GetColor(L, XCAFDoc_ColorSurf, c) || ctool->GetColor(L, XCAFDoc_ColorGen, c)
                     || ctool->GetColor(s, XCAFDoc_ColorSurf, c) || ctool->GetColor(s, XCAFDoc_ColorGen, c);
            if (!hasC) bad("'" + e.name + "': no body colour read back");
            else {
                Standard_Real r, g2, b2; c.Values(r, g2, b2, Quantity_TOC_sRGB);
                const uint32_t got = ((uint32_t)std::lround(r * 255) << 16) | ((uint32_t)std::lround(g2 * 255) << 8) | (uint32_t)std::lround(b2 * 255);
                if (got != e.rgb) { char m[128]; std::snprintf(m, sizeof m, "'%s': colour %06x, expected %06x", e.name.c_str(), got, e.rgb); bad(m); }
            }
            size_t ov = 0;
            for (TopExp_Explorer x(s, TopAbs_FACE); x.More(); x.Next()) {
                Quantity_Color fc;
                if (ctool->GetColor(x.Current(), XCAFDoc_ColorSurf, fc)) ov++;
            }
            if (ov != e.faceOverrides)
                bad("'" + e.name + "': " + std::to_string(ov) + " face colour(s) read back, expected " + std::to_string(e.faceOverrides));
            break;
        }
        if (!found) bad("part '" + e.name + "' not found in the re-read document");
    }
    std::cerr << (fails ? cWarn() : cOk()) << "  " << label << cReset() << " : " << st.parts << " parts, "
              << st.nManifold << " manifold / " << st.nFaceted << " faceted / " << st.nSphere << " sphere / "
              << st.nTess << " tessellated / " << st.nOpen << " open, " << st.entities << " entities, " << (txt.size() / 1024.0) << " KB, " << st.totalMs << " ms\n";
    return 0;
}

// ── [24/09] Aller-retour EXACT : fichier source a instances -> import MEDUSA
// (cache des B-Rep) -> export par reference -> relecture OCCT. Le cone porte un
// ANGLE (demi-angle de CONICAL_SURFACE) : c'est lui qui a revele que les unites
// d'angle n'etaient pas lues comme des radians. Verifie : prototypes partages
// (2 MANIFOLD_SOLID_BREP pour 4 corps), volumes exacts, placements (identite
// puis rotation + translation), couleurs de corps et de face, repli maillage
// d'une reference perimee.
static std::string makeExactSource() {
    Handle(TDocStd_Document) doc;
    XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
    Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) ct = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    const TopoDS_Shape cone = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, 0), gp::DZ()), 5, 2, 10).Shape();
    const TopoDS_Shape box = BRepPrimAPI_MakeBox(10, 20, 5).Shape();
    const TDF_Label asmL = st->NewShape(); TDataStd_Name::Set(asmL, "Assy");
    const TDF_Label coneL = st->AddShape(cone, Standard_False); TDataStd_Name::Set(coneL, "Cone");
    const TDF_Label boxL = st->AddShape(box, Standard_False); TDataStd_Name::Set(boxL, "Block");
    ct->SetColor(coneL, Quantity_Color(1, 0, 0, Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
    ct->SetColor(boxL, Quantity_Color(0, 0, 1, Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
    TopExp_Explorer fx(box, TopAbs_FACE);
    const TDF_Label fL = st->AddSubShape(boxL, fx.Current());
    if (!fL.IsNull()) ct->SetColor(fL, Quantity_Color(0, 1, 0, Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
    gp_Trsf t1; t1.SetTranslation(gp_Vec(30, 0, 0));
    gp_Trsf t2; t2.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp::DX()), M_PI / 2); t2.SetTranslationPart(gp_Vec(0, 40, 0));
    gp_Trsf t3; t3.SetTranslation(gp_Vec(0, -40, 0));
    st->AddComponent(asmL, coneL, TopLoc_Location());
    st->AddComponent(asmL, coneL, TopLoc_Location(t1));
    st->AddComponent(asmL, coneL, TopLoc_Location(t2));
    st->AddComponent(asmL, boxL, TopLoc_Location(t3));
    st->UpdateAssemblies();
    STEPCAFControl_Writer w;
    if (!w.Transfer(doc, STEPControl_AsIs)) return std::string();
    const std::string tmp = (std::filesystem::temp_directory_path() / ("nasscad_selftest_" + sessionNonce() + ".stp")).string();
    if (w.Write(tmp.c_str()) != IFSelect_RetDone) return std::string();
    std::ifstream f(tmp, std::ios::binary); std::ostringstream ss; ss << f.rdbuf(); f.close(); std::remove(tmp.c_str());
    return ss.str();
}
struct SolidInfo { double v; gp_Pnt c; std::map<uint32_t, int> faceCol; };
static std::vector<SolidInfo> readSolids(const std::string& txt) {
    std::vector<SolidInfo> out;
    Handle(TDocStd_Document) doc;
    XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
    STEPCAFControl_Reader caf; caf.SetColorMode(true); caf.SetNameMode(true);
    std::istringstream is(txt);
    if (caf.ChangeReader().ReadStream("x.step", is) != IFSelect_RetDone || !caf.Transfer(doc)) return out;
    Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) ctl = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    TDF_LabelSequence fr; st->GetFreeShapes(fr);
    std::function<void(const TDF_Label&, const TopLoc_Location&, uint32_t)> walk =
        [&](const TDF_Label& L, const TopLoc_Location& loc, uint32_t inherited) {
        TDF_Label R = L; TopLoc_Location my = loc;
        if (st->IsReference(L)) { st->GetReferredShape(L, R); my = loc * st->GetLocation(L); }
        Quantity_Color c; uint32_t col = inherited;
        auto hex = [](const Quantity_Color& q) { Standard_Real a, b, d; q.Values(a, b, d, Quantity_TOC_sRGB);
            return ((uint32_t)std::lround(a * 255) << 16) | ((uint32_t)std::lround(b * 255) << 8) | (uint32_t)std::lround(d * 255); };
        if (ctl->GetColor(L, XCAFDoc_ColorSurf, c) || ctl->GetColor(R, XCAFDoc_ColorSurf, c)) col = hex(c);
        if (st->IsAssembly(R)) {
            TDF_LabelSequence comps; st->GetComponents(R, comps);
            for (int k = 1; k <= comps.Length(); k++) walk(comps.Value(k), my, col);
            return;
        }
        const TopoDS_Shape proto = st->GetShape(R);
        for (TopExp_Explorer x(proto, TopAbs_SOLID); x.More(); x.Next()) {
            SolidInfo si;
            const TopoDS_Shape placed = x.Current().Moved(my);
            GProp_GProps g; BRepGProp::VolumeProperties(placed, g);
            si.v = std::fabs(g.Mass()); si.c = g.CentreOfMass();
            for (TopExp_Explorer f(x.Current(), TopAbs_FACE); f.More(); f.Next()) {
                Quantity_Color fc; uint32_t h = col;
                if (ctl->GetColor(f.Current(), XCAFDoc_ColorSurf, fc)) h = hex(fc);
                si.faceCol[h]++;
            }
            out.push_back(si);
        }
    };
    for (int i = 1; i <= fr.Length(); i++) walk(fr.Value(i), TopLoc_Location(), 0xFFFFFFFFu);
    return out;
}
static void runExactRoundTrip(int& fails) {
    auto bad = [&](const std::string& m) { std::cerr << cErr() << "  FAIL" << cReset() << " [exact round-trip] " << m << "\n"; fails++; };
    const std::string src = makeExactSource();
    if (src.empty()) { bad("could not build the source file"); return; }
    std::vector<MeshData> meshes;
    double tessMs = 0; int faceCount = 0;
    // Etiquette de CONTENU, comme le client (?tag= = empreinte du fichier).
    const std::string tag = "h0123456789abcdef0123456789abcdef";
    try { processStepBuffer(src, 0.0, tessMs, faceCount, [&](const MeshData& m) { meshes.push_back(m); }, tag); }
    catch (const std::exception& e) { bad(std::string("import failed: ") + e.what()); return; }
    if (meshes.size() != 4) { bad("import gave " + std::to_string(meshes.size()) + " bodies, expected 4"); return; }
    for (auto& m : meshes) if (m.ref.empty()) { bad("imported body without exact reference"); return; }
    for (auto& m : meshes)
        if (m.ref.compare(0, tag.size() + 1, tag + ":") != 0 || std::count(m.ref.begin(), m.ref.end(), ':') != 2) {
            bad("reference '" + m.ref + "' is not <file tag>:<rank>:<signature>"); return;
        }
    const std::vector<SolidInfo> ref = readSolids(src);
    if (ref.size() != 4) { bad("source re-read gave " + std::to_string(ref.size()) + " solids"); return; }
    const double coneV = M_PI * 10.0 / 3.0 * (25.0 + 10.0 + 4.0);
    // Transformation appliquee a l'export : rotation de 90 deg autour de Z + translation.
    const double rotZ[12] = {0, -1, 0, 10,  1, 0, 0, 20,  0, 0, 1, 30};
    const double ident[12] = {1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0};
    for (int pass = 0; pass < 3; pass++) {
        const int ap = pass == 2 ? 2 : 0;
        const double* M = pass == 1 ? rotZ : ident;
        Req rq(ap, 1, 5, 1e-5);
        for (auto& m : meshes) {
            uint32_t rgb = m.hasColor ? (((uint32_t)std::lround(m.r * 255) << 16) | ((uint32_t)std::lround(m.g * 255) << 8) | (uint32_t)std::lround(m.b * 255)) : 0xcccccc;
            if (!m.faces.empty()) {                 // couleur de corps = teinte dominante, comme le client
                std::map<uint32_t, uint32_t> area;
                for (auto& f : m.faces) area[((uint32_t)std::lround(f.r * 255) << 16) | ((uint32_t)std::lround(f.g * 255) << 8) | (uint32_t)std::lround(f.b * 255)] += f.count;
                uint32_t best = 0; for (auto& kv : area) if (kv.second > best) { best = kv.second; rgb = kv.first; }
            }
            rq.head(2, m.name, rgb, 1.0, {});
            rq.str(m.ref);
            for (int k = 0; k < 12; k++) rq.f64(M[k]);
            rq.u32(0);
            const uint32_t nV = (uint32_t)(m.positions.size() / 3), nT = (uint32_t)(m.indices.size() / 3);
            rq.u32(nV); rq.u32(nT); rq.u32(1);
            rq.b.append((const char*)m.positions.data(), m.positions.size() * 4);
            rq.b.append((const char*)m.indices.data(), m.indices.size() * 4);
        }
        stepx::Stats st;
        const std::string txt = stepx::exportStepToString(rq.b, st);
        std::string why;
        const std::string label = std::string(pass == 1 ? "rotated" : "identity") + (ap == 2 ? " AP242" : " AP203");
        if (!checkPart21(txt, why)) { bad(label + ": Part 21 integrity: " + why); continue; }
        if (st.nExact != 4 || st.nProtos != 2) bad(label + ": " + std::to_string(st.nExact) + " exact bodies / " + std::to_string(st.nProtos) + " prototypes, expected 4 / 2");
        size_t nBrep = 0; for (size_t p = 0; (p = txt.find("MANIFOLD_SOLID_BREP(", p)) != std::string::npos; p++) nBrep++;
        if (nBrep != 2) bad(label + ": " + std::to_string(nBrep) + " MANIFOLD_SOLID_BREP in the file, expected 2 (instancing)");
        const std::vector<SolidInfo> got = readSolids(txt);
        if (got.size() != 4) { bad(label + ": re-read gave " + std::to_string(got.size()) + " solids"); continue; }
        size_t matched = 0, cones = 0;
        for (const SolidInfo& r : ref) {
            gp_Pnt e = r.c;
            if (pass == 1) e = gp_Pnt(M[0]*r.c.X() + M[1]*r.c.Y() + M[2]*r.c.Z() + M[3], M[4]*r.c.X() + M[5]*r.c.Y() + M[6]*r.c.Z() + M[7],
                                      M[8]*r.c.X() + M[9]*r.c.Y() + M[10]*r.c.Z() + M[11]);
            for (const SolidInfo& g : got)
                if (g.c.Distance(e) < 1e-4 && std::fabs(g.v - r.v) < 1e-6 * r.v) {
                    matched++;
                    if (std::fabs(g.v - coneV) < 1e-6 * coneV) cones++;
                    if (g.faceCol != r.faceCol) bad(label + ": face colours differ from the source for a solid of volume " + std::to_string(r.v));
                    break;
                }
        }
        if (matched != 4) bad(label + ": " + std::to_string(matched) + "/4 solids found at their place with their exact volume");
        if (cones != 3) bad(label + ": " + std::to_string(cones) + "/3 cones with the exact volume (angle unit?)");
        std::cerr << (fails ? cWarn() : cOk()) << "  exact round-trip " << label << cReset() << " : " << st.nExact << " exact bodies, "
                  << st.nProtos << " prototypes, " << txt.size() << " bytes\n";
    }
    { // reference perimee -> repli maillage, jamais un mauvais corps
        Req rq(0, 1, 5, 1e-5);
        const MeshData& m = meshes[0];
        rq.head(2, m.name, 0xff0000, 1.0, {}); rq.str("0000000000000000-999:0:00000000");
        for (int k = 0; k < 12; k++) rq.f64(ident[k]);
        rq.u32(0);
        rq.u32((uint32_t)(m.positions.size() / 3)); rq.u32((uint32_t)(m.indices.size() / 3)); rq.u32(1);
        rq.b.append((const char*)m.positions.data(), m.positions.size() * 4);
        rq.b.append((const char*)m.indices.data(), m.indices.size() * 4);
        stepx::Stats st;
        const std::string txt = stepx::exportStepToString(rq.b, st);
        if (st.exactMissing != 1 || st.nExact != 0 || st.parts != 1) bad("stale reference: not sent back to the mesh path");
        else std::cerr << cOk() << "  exact round-trip stale reference" << cReset() << " : written from the mesh, as it must\n";
    }
    // ── [24/09, soir] Le B-Rep n'est plus tenu (MEDUSA redemarre, import sorti
    // du cache navigateur) : /stepload le relit SANS maillage sous la meme
    // etiquette, et les MEMES references doivent retrouver les memes pieces.
    auto exportRefs = [&](const std::vector<std::string>& refs, stepx::Stats& st) {
        Req rq(0, 1, 5, 1e-5);
        for (size_t i = 0; i < meshes.size(); i++) {
            const MeshData& m = meshes[i];
            rq.head(2, m.name, 0xcccccc, 1.0, {});
            rq.str(refs[i]);
            for (int k = 0; k < 12; k++) rq.f64(ident[k]);
            rq.u32(0);
            rq.u32((uint32_t)(m.positions.size() / 3)); rq.u32((uint32_t)(m.indices.size() / 3)); rq.u32(1);
            rq.b.append((const char*)m.positions.data(), m.positions.size() * 4);
            rq.b.append((const char*)m.indices.data(), m.indices.size() * 4);
        }
        return stepx::exportStepToString(rq.b, st);
    };
    std::vector<std::string> refs;
    for (auto& m : meshes) refs.push_back(m.ref);
    {   // redemarrage simule : plus rien n'est tenu -> maillage, sans erreur
        { std::lock_guard<std::mutex> lk(gImportMx); gImports.clear(); }
        stepx::Stats st;
        exportRefs(refs, st);
        if (st.nExact != 0 || st.exactMissing != 4) bad("after a restart: " + std::to_string(st.nExact) + " exact / "
                                                         + std::to_string(st.exactMissing) + " missing, expected 0 / 4");
    }
    try {   // /stepload : relecture exacte seule, meme etiquette
        std::vector<MeshData> none;
        double t2 = 0; int f2 = 0;
        processStepBuffer(src, -1.0, t2, f2, [&](const MeshData& m) { none.push_back(m); }, tag, true);
        if (!none.empty()) bad("exact-only reload produced " + std::to_string(none.size()) + " mesh(es), expected none");
        processStepBuffer(src, -1.0, t2, f2, nullptr, tag, true);          // relu deux fois : remplace, n'empile pas
        size_t held = 0;
        for (const std::string& t : heldImportTags()) if (t == tag) held++;
        if (held != 1) bad("the same file read twice is held " + std::to_string(held) + " time(s), expected once");
        stepx::Stats st;
        const std::string txt = exportRefs(refs, st);
        std::string why;
        if (!checkPart21(txt, why)) bad("after reload: Part 21 integrity: " + why);
        const std::vector<SolidInfo> got = readSolids(txt);
        size_t matched = 0;
        for (const SolidInfo& r : ref)
            for (const SolidInfo& g : got)
                if (g.c.Distance(r.c) < 1e-4 && std::fabs(g.v - r.v) < 1e-6 * r.v) { matched++; break; }
        if (st.nExact != 4 || st.nProtos != 2 || matched != 4)
            bad("after reload: " + std::to_string(st.nExact) + " exact / " + std::to_string(st.nProtos) + " prototypes / "
                + std::to_string(matched) + " solids in place, expected 4 / 2 / 4");
        else std::cerr << cOk() << "  exact round-trip reload" << cReset() << " : B-Rep re-read without tessellation, same references, same solids\n";
        // Signature alteree : ce rang ne designe plus « cette » piece -> maillage.
        std::vector<std::string> bent = refs;
        bent[0].back() = bent[0].back() == '0' ? '1' : '0';
        stepx::Stats st2;
        exportRefs(bent, st2);
        if (st2.nExact != 3 || st2.exactMissing != 1) bad("a reference with a wrong signature was not refused");
        else std::cerr << cOk() << "  exact round-trip signature" << cReset() << " : a reference whose part changed is written from the mesh\n";
    } catch (const std::exception& e) { bad(std::string("exact-only reload failed: ") + e.what()); }
}

} // namespace stepxtest

static int runStepExportSelfTestCli() {
    using namespace stepxtest;
    std::cerr << cBold() << "--- STEP export self-test (native writer, re-read by OCCT " OCC_VERSION_COMPLETE ") ---" << cReset() << "\n";
    // Plaque 10x10x4 percee 4x4 de part en part : 400 - 64 = 336 mm3 (cas du
    // commentaire [FIX V4.2.7] de step-export.js — face plane a trou).
    TopoDS_Shape plate = BRepAlgoAPI_Cut(BRepPrimAPI_MakeBox(10, 10, 4).Shape(),
                                         BRepPrimAPI_MakeBox(gp_Pnt(3, 3, -1), 4, 4, 6).Shape()).Shape();
    Mesh mPlate = meshOf(plate, 0.1);
    Mesh mCyl = meshOf(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(20, 0, 0), gp::DZ()), 5, 10).Shape(), 0.05);
    const double vCyl = std::fabs(meshVolume(mCyl));
    Mesh mTorus = meshOf(BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(-20, 0, 0), gp::DZ()), 6, 2).Shape(), 0.05);
    const double vTorus = std::fabs(meshVolume(mTorus));
    // Cube multicolore : les 2 triangles du dessus (z = 5) en materiau 1.
    Mesh mCube = meshOf(BRepPrimAPI_MakeBox(gp_Pnt(0, 20, 0), 5, 5, 5).Shape(), 0.1);
    mCube.mat.assign(mCube.idx.size() / 3, 0);
    for (size_t t = 0; t < mCube.mat.size(); t++) {
        bool top = true;
        for (int k = 0; k < 3; k++) if (std::fabs(mCube.pos[mCube.idx[t*3+k]*3+2] - 5.0f) > 1e-4f) top = false;
        if (top) mCube.mat[t] = 1;
    }
    // Boite ouverte : cube sans sa face du dessus -> coque ouverte.
    Mesh mOpen = meshOf(BRepPrimAPI_MakeBox(gp_Pnt(0, -20, 0), 6, 6, 6).Shape(), 0.1);
    { Mesh o; o.pos = mOpen.pos;
      for (size_t t = 0; t < mOpen.idx.size(); t += 3) {
          bool top = true;
          for (int k = 0; k < 3; k++) if (std::fabs(mOpen.pos[mOpen.idx[t+k]*3+2] - 6.0f) > 1e-4f) top = false;
          if (!top) { o.idx.push_back(mOpen.idx[t]); o.idx.push_back(mOpen.idx[t+1]); o.idx.push_back(mOpen.idx[t+2]); }
      }
      mOpen = o; }
    // Tore bicolore : les triangles du cote x < -20 en materiau 1 -> une
    // TRIANGULATED_FACE par couleur en AP242, une couleur par facette ailleurs.
    Mesh mTorusRGB = meshOf(BRepPrimAPI_MakeTorus(gp_Ax2(gp_Pnt(-20, 30, 0), gp::DZ()), 6, 2).Shape(), 0.05);
    const double vTorusRGB = std::fabs(meshVolume(mTorusRGB));
    mTorusRGB.mat.assign(mTorusRGB.idx.size() / 3, 0);
    size_t nRgbTris = 0;
    for (size_t t = 0; t < mTorusRGB.mat.size(); t++) {
        double cx = 0; for (int k = 0; k < 3; k++) cx += mTorusRGB.pos[mTorusRGB.idx[t*3+k]*3];
        if (cx / 3 < -20.0) { mTorusRGB.mat[t] = 1; nRgbTris++; }
    }
    const std::string uniName = "Pi\xC3\xA8" "ce \xC3\x98" "12 'quote' \\ \xF0\x9F\x98\x80";   // Pièce Ø12 'quote' \ 😀
    const double pi = 3.14159265358979323846;
    int fails = 0;
    const char* apN[3] = {"AP203", "AP214", "AP242"};
    for (int ap = 0; ap < 3; ap++) {
        Req rq(ap, 1, 5, 1e-5);
        rq.mesh("Plate", mPlate, 0x3366cc);
        rq.mesh("Cylinder", toSoup(mCyl), 0x999999);                        // soupe non indexee
        rq.mesh("Torus", mTorus, 0x228b22);
        rq.mesh(uniName, mCube, 0xcccccc, 1.0, {{0xcccccc, 1.0}, {0xff0000, 1.0}});
        rq.mesh("OpenBox", mOpen, 0xffaa00);
        rq.sphere("Ball", 1, 2, 3, 7, 0x00aaff);
        rq.mesh("TorusRGB", mTorusRGB, 0x2255aa, 1.0, {{0x2255aa, 1.0}, {0xee3322, 1.0}});
        const bool t242 = ap == 2;
        const std::vector<Expect> ex = {
            {"Plate", 336.0, true, 0x3366cc, 0, "MANIFOLD_SOLID_BREP"},
            {"Cylinder", vCyl, true, 0x999999, 0},
            {"Torus", vTorus, true, 0x228b22, 0, t242 ? "TESSELLATED_SOLID" : "FACETED_BREP"},
            {uniName, 125.0, true, 0xcccccc, 1, "MANIFOLD_SOLID_BREP"},
            {"OpenBox", 0, false, 0xffaa00, 0, t242 ? "TESSELLATED_SHELL" : "SHELL_BASED_SURFACE_MODEL"},
            {"Ball", 4.0 / 3.0 * pi * 343.0, true, 0x00aaff, 0, "MANIFOLD_SOLID_BREP"},
            {"TorusRGB", vTorusRGB, true, 0x2255aa, t242 ? 1 : nRgbTris, t242 ? "TESSELLATED_SOLID" : "FACETED_BREP"},
        };
        runOne(apN[ap], rq, ex, fails);
    }
    { // Mode « Facets » en AP242 : jamais de merge -> tout en tessele.
        Req rq(2, 2, 6, 1e-6);
        rq.mesh("Plate", mPlate, 0x3366cc);
        rq.mesh("Cube", mCube, 0xcccccc, 1.0, {{0xcccccc, 1.0}, {0xff0000, 1.0}});
        runOne("AP242 FACETED", rq, {{"Plate", 336.0, true, 0x3366cc, 0, "TESSELLATED_SOLID"},
                                     {"Cube", 125.0, true, 0xcccccc, 1, "TESSELLATED_SOLID"}}, fails);
    }
    { // Mode « Facets » en AP214 : FACETED_BREP compact, une couleur par facette.
        Req rq(1, 2, 6, 1e-6);
        rq.mesh("Plate", mPlate, 0x3366cc);
        rq.mesh("Cube", mCube, 0xcccccc, 1.0, {{0xcccccc, 1.0}, {0xff0000, 1.0}});
        runOne("AP214 FACETED", rq, {{"Plate", 336.0, true, 0x3366cc, 0, "FACETED_BREP"},
                                     {"Cube", 125.0, true, 0xcccccc, 2, "FACETED_BREP"}}, fails);
    }
    { // Un seul corps -> un seul produit, pas d'assemblage.
        Req rq(2, 0, 6, 1e-6);
        rq.mesh("Solo", mPlate, 0x123456, 0.5);
        runOne("AP242 single body, transparent", rq, {{"Solo", 336.0, true, 0x123456, 0}}, fails);
    }
    runExactRoundTrip(fails);
    { // [24/09] Garde des B-splines periodiques (cf. stepx::exactGeometrySafe) :
      // la courbe de Cruise_Assembly qui tuait MEDUSA sous Windows est refusee,
      // les periodiques saines passent, aucun faux positif sur des NURBS reelles.
        const int f0 = fails;
        auto bad = [&](const std::string& m) { std::cerr << cErr() << "  FAIL" << cReset() << " [periodic B-spline guard] " << m << "\n"; fails++; };
        NCollection_Array1<int> m3(1, 3); m3.Init(1);
        NCollection_Array1<int> m5(1, 5); m5.Init(1);
        if (stepx::unperiodizeSafe(m3, 3)) bad("degenerate knot vector (degree 3, 3 knots of multiplicity 1) accepted");
        if (!stepx::unperiodizeSafe(m5, 3)) bad("valid periodic knot vector (degree 3, 5 knots) refused");
        // La courbe telle que lue dans Cruise_Assembly : degre 3, 2 poles, periode 1,1e-5.
        NCollection_Array1<gp_Pnt> p2(1, 2); p2(1) = gp_Pnt(0, 0, 0); p2(2) = gp_Pnt(1e-5, 0, 0);
        NCollection_Array1<double> k3(1, 3); k3(1) = 0.0; k3(2) = 5.58896785e-06; k3(3) = 1.11779357e-05;
        bool degBuilt = false;
        try {
            Handle(Geom_BSplineCurve) dg = new Geom_BSplineCurve(p2, k3, m3, 3, Standard_True);
            degBuilt = true;
            if (stepx::curveWritable(dg)) bad("the degenerate periodic curve of Cruise_Assembly was not refused");
            if (stepx::curveWritable(new Geom_TrimmedCurve(dg, 0.0, 5e-6))) bad("the same curve, trimmed, was not refused");
        } catch (...) { /* OCCT refuse deja de la construire : rien a garder */ }
        // Periodique saine : degre 3, 4 poles, 5 noeuds.
        NCollection_Array1<gp_Pnt> p4(1, 4);
        p4(1) = gp_Pnt(10, 0, 0); p4(2) = gp_Pnt(0, 10, 0); p4(3) = gp_Pnt(-10, 0, 0); p4(4) = gp_Pnt(0, -10, 0);
        NCollection_Array1<double> k5(1, 5); for (int i = 1; i <= 5; i++) k5(i) = i - 1.0;
        Handle(Geom_BSplineCurve) sane = new Geom_BSplineCurve(p4, k5, m5, 3, Standard_True);
        if (!sane->IsPeriodic() || !stepx::curveWritable(sane)) bad("a valid periodic cubic was refused");
        // NURBS reelles : cylindre, tore et sphere convertis (B-splines periodiques
        // en U, cercles en courbes periodiques) -> toutes ecrivables.
        const TopoDS_Shape prims[3] = {BRepPrimAPI_MakeCylinder(5, 10).Shape(), BRepPrimAPI_MakeTorus(6, 2).Shape(),
                                       BRepPrimAPI_MakeSphere(7).Shape()};
        int nPer = 0;
        for (const TopoDS_Shape& s0 : prims) {
            const TopoDS_Shape s = BRepBuilderAPI_NurbsConvert(s0, Standard_True).Shape();
            for (TopExp_Explorer x(s, TopAbs_FACE); x.More(); x.Next()) {
                TopLoc_Location L;
                Handle(Geom_BSplineSurface) b = Handle(Geom_BSplineSurface)::DownCast(BRep_Tool::Surface(TopoDS::Face(x.Current()), L));
                if (!b.IsNull() && (b->IsUPeriodic() || b->IsVPeriodic())) nPer++;
            }
            if (!stepx::exactGeometrySafe(s)) bad("a NURBS-converted primitive was refused (false positive)");
        }
        if (fails == f0)
            std::cerr << "  periodic B-spline guard : degenerate curve " << (degBuilt ? "refused" : "not even constructible")
                      << ", valid periodic geometry kept (" << nPer << " periodic NURBS face(s) checked)\n";
    }
    if (fails) { std::cerr << cErr() << "STEP export self-test: " << fails << " FAILURE(S)" << cReset() << "\n"; return 1; }
    std::cerr << cOk() << "STEP export self-test: ALL PASS" << cReset() << "\n";
    return 0;
}

int main(int argc, char** argv) {
#ifdef _WIN32
    // [FIX affichage] Le fichier source est en UTF-8 (tirets cadratins —,
    // accents dans les commentaires/logs francais). cmd.exe/PowerShell
    // demarrent par defaut sur la codepage OEM (CP850/CP437 en France), pas
    // UTF-8 : chaque sequence UTF-8 multi-octets (ex: E2 80 94 pour "—") est
    // alors reinterpretee octet par octet via cette codepage -> mojibake
    // ("ÔÇö" au lieu de "—"). SetConsoleOutputCP(CP_UTF8) fait comprendre a
    // la console que les octets qu'on lui envoie SONT de l'UTF-8 -- meme
    // combinaison std::cerr/std::cout + UTF-8 litteral que sous WSL, ou le
    // terminal Linux est deja nativement en UTF-8 (d'ou l'absence du
    // probleme la-bas). Doit etre fait ICI, avant la toute premiere ligne
    // ecrite (banniere comprise).
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);
#endif
#ifdef _WIN32
    // [MSVC] Couleurs ANSI via SetConsoleMode (Windows 10 build 1511+).
    // GetConsoleMode echoue si stderr est redirige vers un fichier/pipe —
    // dans ce cas gUseColor reste false, comportement correct.
    {
        HANDLE hErr = GetStdHandle(STD_ERROR_HANDLE);
        DWORD  mode = 0;
        if (hErr != INVALID_HANDLE_VALUE && GetConsoleMode(hErr, &mode)) {
            if (SetConsoleMode(hErr, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
                gUseColor = true;
        }
    }
#else
    // [12/08] Couleur console UNIQUEMENT si stderr est un vrai terminal (pas une
    // redirection vers fichier/pipe) — determine une seule fois, ici, avant la
    // toute premiere ligne de log.
    gUseColor = isatty(fileno(stderr)) != 0;
#endif
    // [15/08] Mode diagnostic "--decode-colors" -- AVANT toute autre
    // initialisation (pas de medusa.log, pas de socket) : c'est une commande
    // ponctuelle, pas un demarrage de serveur. Voir runDecodeColorsCli().
    if (argc > 1 && std::string(argv[1]) == "--decode-colors") {
        if (argc < 3) {
            std::cerr << "Usage: " << argv[0] << " --decode-colors file.step\n";
            return 1;
        }
        return runDecodeColorsCli(argv[2]);
    }
    // [31/08] Idem, sans fichier : banc d'essai de la table de decision couleur.
    if (argc > 1 && std::string(argv[1]) == "--selftest-colors") {
        return runColorSelfTestCli();
    }
    // [21/09] Banc d'essai de la couture par topologie — cas a reponse connue
    // (seam, apex degenere, instance placee loin), verification topologique
    // exacte + volume compare au B-Rep. Voir runWeldSelfTestCli().
    if (argc > 1 && std::string(argv[1]) == "--selftest-weld") {
        return runWeldSelfTestCli();
    }
    // [24/09] Banc de l'export STEP natif : ecrit, relit par OCCT, compare.
    // Voir runStepExportSelfTestCli().
    if (argc > 1 && std::string(argv[1]) == "--selftest-stepexport") {
        return runStepExportSelfTestCli();
    }
    // [10/08] Log fichier dans Telechargements si detectable dynamiquement
    // (voir getWindowsDownloadsPath, aucun nom d'utilisateur en dur) — repli
    // sur chemin relatif (medusa.log, dossier courant) si l'interop Windows
    // echoue. Tronque a chaque demarrage (pas d'ajout indefini entre sessions).
    // [28/08] Meme formalisme que l'export de logs NASSCAD, a la demande :
    //     nasscad-logs-2026-08-28_16-21-52.txt   (client, logExport())
    //     medusa-logs-2026-08-28_16-28-49.txt    (ici)
    // Horodate a la SECONDE et en heure LOCALE — comme _fmtLogFilename() cote
    // client, pour que les deux journaux d'une meme session se rangent cote a
    // cote et se lisent en parallele.
    //
    // CONSEQUENCE ASSUMEE : un fichier par demarrage, au lieu d'un medusa.log
    // unique tronque a chaque fois. C'est le prix du formalisme demande — plus
    // rien n'est ecrase, mais le dossier se remplit si le moteur est relance
    // souvent. Aucune retention automatique pour l'instant.
    // [04/09] PLUS DE FICHIER PAR DEFAUT. Le bloc ci-dessous ne s'exerce que si
    // --logfile est passe ; sinon rien n'est cree, rien ne s'accumule, et le
    // journal reste disponible par GET /log (tampon circulaire, cf. gLogRing).
    // getWindowsDownloadsPath() n'est meme plus appele sans le flag : c'est un
    // aller-retour cmd.exe + wslpath a chaque demarrage, pour un fichier dont on
    // ne veut plus.
    bool wantLogFile = false;
    for (int i = 1; i < argc; ++i)
        if (std::string(argv[i]) == "--logfile") wantLogFile = true;
    std::string downloadsDir = wantLogFile ? getWindowsDownloadsPath() : std::string();
    std::string logName = "medusa-logs-" + logFileStamp() + ".txt";
    std::string logPath = !downloadsDir.empty() ? (downloadsDir + "/" + logName) : logName;
    static std::ofstream gLogFile;
    if (wantLogFile) gLogFile.open(logPath, std::ios::trunc);
    // Le Tee est installe DANS TOUS LES CAS, meme sans fichier : il n'est plus
    // seulement un doubleur console/fichier, c'est lui qui alimente le tampon.
    static TeeStreambuf gTeeBuf(std::cerr.rdbuf(), gLogFile.is_open() ? gLogFile.rdbuf() : nullptr);
    // [FIX AUDIT 18/08 — demande Nass] La redirection cerr->fichier doit rester ICI,
    // tot, pour que TOUT (banniere comprise) finisse aussi dans medusa.log — mais
    // l'ANNONCE console "[OK] Log file: ..." est desormais differee (cf. plus bas,
    // juste apres la ligne "native /repair") : affichage seulement, la capture
    // fichier elle-meme n'attend pas et ne perd donc aucune ligne.
    // [04/09] Redirection INCONDITIONNELLE desormais : sans fichier le Tee reste
    // indispensable, c'est lui qui remplit le tampon interrogeable par GET /log.
    // La condition d'origine aurait rendu /log vide des qu'on n'ecrit pas de fichier.
    std::cerr.rdbuf(&gTeeBuf);
    // [24/09] Rapport de plantage — arme des que le journal existe (il en recopie
    // la fin), avant tout travail. Cf. crashrep.
    const std::string crashDir = crashrep::install();
    // [24/09] --selftest-crash / --selftest-crash-terminate : verifient le rapport
    // de plantage de bout en bout sur la machine meme (ecriture a l'adresse 0,
    // puis exception non attrapee dans un thread).
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--selftest-crash") {
            std::cerr << "[TEST] deliberate crash (write to address 0) - a report must appear in " << crashDir << "\n";
            volatile int* volatile p = nullptr;
            *p = 42;
        }
        if (a == "--selftest-crash-terminate") {
            std::cerr << "[TEST] deliberate uncaught exception in a thread - a report must appear in " << crashDir << "\n";
            std::thread([] { throw std::runtime_error("deliberate test exception"); }).join();
        }
    }

#ifndef _WIN32
    // SIGPIPE : si le navigateur coupe la connexion PENDANT que le serveur ecrit la
    // reponse (gros buffer NSTP de 60+ Mo = fenetre de plusieurs secondes — onglet
    // recharge, timeout cote JS, F5...), le comportement POSIX par defaut TUE le
    // process entier, sans exception, sans passer par aucun catch. C'est la cause
    // la plus probable des arrets fantomes constates ("MEDUSA arrete" apres un gros
    // import sans que personne n'ait rien ferme). Ignore : send() retourne alors
    // une erreur normale, geree par writeAll qui abandonne proprement CETTE reponse.
    signal(SIGPIPE, SIG_IGN);
#endif
    int port = (argc > 1) ? std::atoi(argv[1]) : 8765;
    // argv[2] : deflection FORCEE pour toute la session (test A/B non-manifold vs
    // finesse). Absent = auto (ratio bbox, comportement normal).
    double defaultDeflection = (argc > 2) ? std::atof(argv[2]) : -1.0;
    if (defaultDeflection > 0) gDeflectionOverride = defaultDeflection;
    // argv[3] : coefficient de qualite de la deflection adaptative par corps
    // (defaut 0.0015 = 0,15 % de la diagonale du corps). Plus petit = plus fin et
    // plus lourd. C'est LE bouton de reglage qualite/cout : il se regle sans
    // recompiler, contrairement a la constante. Ignore si argv[2] force deja une
    // deflection uniforme.
    if (argc > 3) {
        // argv[3] : en ratio (0.005) ou en pourcents (0.5) — les deux se
        // distinguent sans ambiguite, aucune deviation utile n'atteint 1.
        double k = std::atof(argv[3]);
        if (k > 0.0 && k < 1.0)        gDeviation = k;
        else if (k >= 1.0 && k < 100.0) gDeviation = k / 100.0;
    }
    // argv[4] : budget de triangles par corps (0 = garde-fou desactive). Le test
    // sur le premier caractere evite qu'un drapeau (--logfile) place a cette
    // position soit lu comme un 0 et desactive le garde-fou en silence : atoll
    // rend 0 sur toute chaine non numerique, et 0 est ici une valeur valide.
    if (argc > 4 && argv[4][0] >= '0' && argv[4][0] <= '9') {
        gTriBudgetPerBody = std::atoll(argv[4]);
    }

    // OCCT peut être verbeux sur stderr (warnings de reconstruction topologique) —
    // on garde les messages d'erreur mais on coupe le bruit trace/info par défaut.
    Message::DefaultMessenger()->RemovePrinters(STANDARD_TYPE(Message_Printer));

#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        std::cerr << "WSAStartup failed\n";
        return 1;
    }
#endif

    SocketFD srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv == NASSCAD_SOCK_INVALID) { std::cerr << "socket() failed\n"; return 1; }
    int opt = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1"); // bind STRICT localhost — jamais 0.0.0.0

    if (bind(srv, (sockaddr*)&addr, sizeof(addr)) < 0) {
        std::cerr << "bind() failed on 127.0.0.1:" << port << " — port already in use?\n";
        return 1;
    }
    if (listen(srv, 16) < 0) { std::cerr << "listen() failed\n"; return 1; }

    {
        const std::string title = "=== NASSCAD MEDUSA ENGINE 3.1 ===";
        const std::string border(title.size(), '=');
        std::cerr << cDim() << border << cReset() << "\n";
        std::cerr << cBold() << title << cReset() << "\n";
        std::cerr << cDim() << border << cReset() << "\n";
    }
    {
        // [FIX diagnostic] Un process 32-bit sur Windows est plafonne a ~2-4 Go
        // d'espace d'adressage, QUELLE QUE SOIT la RAM physique de la machine
        // (meme a 64 Go) -- symptome indiscernable d'un vrai manque de memoire
        // vu du process (allocation qui echoue / OOM) mais cause radicalement
        // differente (mauvais toolchain de compilation, pas un vrai probleme
        // memoire). _WIN64 n'est defini QUE pour une compilation 64-bit (meme
        // sous _WIN32, qui couvre les deux) -- verifiable ici sans avoir a
        // ouvrir le Gestionnaire des taches a temps avant un crash.
#if defined(_WIN64)
        std::cerr << cDim() << "[INFO] Architecture: x64 (64-bit)" << cReset() << "\n";
#elif defined(_WIN32)
        std::cerr << cWarn() << "[INFO] Architecture: x86 (32-bit) -- address space capped at ~2-4 GB regardless of physical RAM !" << cReset() << "\n";
#else
        std::cerr << cDim() << "[INFO] Architecture: " << (sizeof(void*) == 8 ? "64-bit" : "32-bit") << cReset() << "\n";
#endif
    }
    std::cerr << cDim() << "native /repair (batch, parallel, mirror of /smooth) — STEP tessellation now parallel too (pool size = " << std::thread::hardware_concurrency() << " threads)" << cReset() << "\n";
    // [FIX AUDIT 18/08 — demande Nass] Annonce differee ici (redirection reelle faite
    // bien plus haut, cf. commentaire pres de gTeeBuf) — ordre d'affichage demande :
    // apres la ligne "native /repair", avant "Listening on".
    if (gLogFile.is_open())
        std::cerr << cOk() << "[OK]" << cReset() << " Log file: " << logPath << (downloadsDir.empty() ? " (Downloads detection failed, using local fallback)" : "") << "\n";
    else if (wantLogFile)
        std::cerr << cWarn() << "[WARN]" << cReset() << " " << logPath << " could not be opened — console only, no file backup this session.\n";
    else
        std::cerr << cOk() << "[OK]" << cReset() << " Log: memory only, last " << kLogRingMax
                  << " lines — GET /log to read it, --logfile to also write a file.\n";
    std::cerr << cOk() << "[OK]" << cReset() << " Crash reporter armed — a crash writes medusa-crash-<time>.txt to "
              << crashDir << "\n";
    std::cerr << cOk() << "[OK]" << cReset() << " Listening on http://127.0.0.1:" << port << " (strict localhost bind)\n";
    if (gDeflectionOverride > 0)
        std::cerr << "Deflection: FORCED to " << gDeflectionOverride << " mm (CLI argument - test mode)\n";
    else
        std::cerr << cInfo() << "[INFO]" << cReset() << " Deflection: adaptive per body, deviation "
                  << (gDeviation * 100.0) << "% of bounding box, angular "
                  << (ANGULAR_DEFLECTION * 180.0 / 3.14159265358979)
                  << " deg, triangle budget/body=" << gTriBudgetPerBody << "\n";
    std::cerr << cInfo() << "[INFO]" << cReset() << " Endpoints: GET /ping | POST /step | POST /ifc | POST /stepstream | POST /stepexport | GET /stepheld | POST /stepload | POST /csg | POST /csgtree | POST /smooth | POST /repair\n";
    std::cerr << cInfo() << "[INFO]" << cReset() << " Live tuning on /step and /stepstream: ?deviation=<%>&budget=<n>&deflection=<mm>\n";
    std::cerr << cOk() << "[OK]" << cReset() << " Ready.\n";

    while (true) {
        sockaddr_in clientAddr{};
        socklen_t clientLen = sizeof(clientAddr);
        SocketFD fd = accept(srv, (sockaddr*)&clientAddr, &clientLen);
        if (fd == NASSCAD_SOCK_INVALID) continue;
        // [PERF 18/08] Nagle desactive sur CETTE socket cliente — sert directement
        // l'objectif deja documente pour GET /ping ("detection au boot, latence
        // minimale") : sans TCP_NODELAY, un petit paquet (reponse /ping, ou meme le
        // tout premier chunk de /stepstream) peut rester coalesce en attendant l'ACK
        // du paquet precedent (algorithme de Nagle) au lieu de partir immediatement
        // — mesurable meme en loopback des que l'ecriture se fait en plusieurs
        // send() (cf. writeAll/writeChunk plus bas). Best-effort, comme SO_REUSEADDR
        // plus haut : valeur de retour ignoree, une socket qui refuse cette option
        // reste utilisable, juste sans le gain de latence.
        {
            int nodelay = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (const char*)&nodelay, sizeof(nodelay));
        }

        // [28/08 AUDIT] Timeouts de socket — indispensables ici, et pas un simple
        // durcissement de principe. Cette boucle est STRICTEMENT SERIE : un seul
        // accept(), une requete traitee de bout en bout, puis la suivante. Sans
        // timeout, une connexion qui s'ouvre et n'envoie jamais rien bloque
        // readHttpRequest() indefiniment dans son recv() — et donc bloque le
        // MOTEUR ENTIER, pas seulement ce client. N'importe quel scan de port, un
        // onglet qui meurt entre le connect() et le send(), un proxy curieux, et
        // NASSCAD affiche "MEDUSA unreachable" alors que le process tourne
        // toujours. Depuis le retrait du repli WASM, ce blocage n'est plus
        // seulement genant : il n'y a plus rien derriere.
        // 30 s, et c'est par appel recv()/send(), pas pour la requete entiere :
        // un gros STEP qui transfere en continu ne les declenche jamais. En cas
        // de declenchement, recv() renvoie -1 -> readHttpRequest() retourne false
        // -> socket fermee, boucle relancee. Exactement le comportement voulu.
        {
#ifdef _WIN32
            DWORD tv = 30000; // millisecondes
#else
            struct timeval tv; tv.tv_sec = 30; tv.tv_usec = 0;
#endif
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
        }

        HttpRequest req;
        // [28/08 AUDIT] Filet autour du parsing : chaque handler d'endpoint a son
        // try/catch, mais readHttpRequest() etait appele a nu dans la boucle.
        // Toute exception qui en sortait n'etait attrapee nulle part et terminait
        // le process. Le cas concret (std::stoul sur un Content-Length non
        // numerique) est corrige a la source ; ce catch couvre le reste — un
        // bad_alloc sur le resize() du corps, en premier lieu.
        bool reqOk = false;
        try {
            reqOk = readHttpRequest(fd, req);
        } catch (const std::exception& e) {
            std::cerr << cErr() << "[HTTP] request rejected:" << cReset() << " " << e.what() << "\n";
            reqOk = false;
        } catch (...) {
            std::cerr << cErr() << "[HTTP] request rejected (non-standard exception)" << cReset() << "\n";
            reqOk = false;
        }
        if (!reqOk) { nasscadCloseSocket(fd); continue; }
        // [21/09] Point de passage UNIQUE : toute requete acceptee passe ici,
        // quel que soit l'endpoint. Cf. noteClientContact pour le pourquoi du
        // « au contact » plutot que sur minuterie.
        noteClientContact(req);
        {   // [24/09] pour le rapport de plantage, cf. crashrep
            char st[40]; crashrep::stamp(st, sizeof st, false);
            std::snprintf(gCrashRequest, sizeof gCrashRequest, "[%s] %s %s (%.1f MB body)", st, req.method.c_str(),
                          req.path.substr(0, 200).c_str(), req.body.size() / 1048576.0);
        }

        if (req.method == "OPTIONS") {
            sendResponse(fd, 204, "No Content", "text/plain", nullptr, 0);
        }
        else if (req.method == "GET" && req.path == "/ping") {
            // [v2.5] /ping machine-aware : MEDUSA est le seul des deux cotes a
            // pouvoir lire le materiel REEL (Firefox n'expose pas deviceMemory,
            // et hardwareConcurrency peut etre bride en mode privacy). Le client
            // s'en sert pour auto-dimensionner pool/workers — cf. incident du
            // 08/08 : pool 2GB sur une machine 8GB = swap, import x8 plus lent.
            // [v2.6] + availMB : RAM REELLEMENT disponible a l'instant T (via
            // /proc/meminfo MemAvailable), pas seulement la RAM totale installee.
            // Sur une machine avec plein d'onglets Firefox deja ouverts, ramMB
            // dit "16 Go installes" quand availMB dit la verite : "3 Go libres
            // maintenant". Le client doit preferer availMB quand present.
            long ramMB = 0;
#ifdef _WIN32
            // Meme logique que readAvailableRamMB() : sys/sysinfo.h (glibc/Linux)
            // n'est pas inclus sous _WIN32 (cf. garde ligne 43), struct sysinfo/
            // sysinfo() n'existent pas sous MSVC/MinGW-w64. GlobalMemoryStatusEx
            // donne l'equivalent Windows de si.totalram.
            MEMORYSTATUSEX statex;
            statex.dwLength = sizeof(statex);
            if (GlobalMemoryStatusEx(&statex)) ramMB = (long)(statex.ullTotalPhys / (1024ULL*1024ULL));
#else
            struct sysinfo si;
            if (sysinfo(&si) == 0) ramMB = (long)((si.totalram * (unsigned long long)si.mem_unit) / (1024ULL*1024ULL));
#endif
            long availMB = readAvailableRamMB();
            unsigned cores = std::thread::hardware_concurrency();
            // [27/08] "csgtree":true — capability flag, PAS un numero de version.
            // Depuis le deport complet des workers Manifold, le client n'a plus de
            // repli WASM : s'il tourne face a un binaire MEDUSA anterieur a cet
            // endpoint, il doit le savoir AVANT d'envoyer un arbre, pour retomber
            // sur sa decomposition post-ordre en /csg successifs plutot que de se
            // prendre un 404 en plein Deep Re-run. Un flag nomme se teste sans
            // parser/comparer des numeros de version.
            std::string j = "{\"engine\":\"nasscad-medusa-engine\",\"version\":\"3.1\",\"occt\":\"" OCC_VERSION_COMPLETE "\",\"protocol\":\"NSTP1\""
                            ",\"csgtree\":true"
                            // [24/09] Export STEP natif (POST /stepexport). Meme
                            // logique que csgtree : le client teste le flag, et un
                            // MEDUSA plus ancien le renvoie simplement au writer JS.
                            ",\"stepexport\":true"
                            // [24/09, soir] GET /stepheld + POST /stepload : le
                            // client recharge un B-Rep que MEDUSA ne tient plus.
                            ",\"stepload\":true"
                            ",\"ramMB\":" + std::to_string(ramMB) +
                            ",\"availMB\":" + std::to_string(availMB) +
                            ",\"cores\":" + std::to_string(cores) +
                            // [17/09] Threads de maillage fuyants depuis le demarrage.
                            // Le client peut ainsi prevenir AVANT que l'utilisateur ne
                            // se demande pourquoi son deuxieme import est plus lent.
                            ",\"runawayThreads\":" + std::to_string(gDetachedCount.load()) +
                            ",\"deviationPct\":" + std::to_string(gDeviation * 100.0) + "}";
            sendResponse(fd, 200, "OK", "application/json", j.data(), j.size());
        }
        // [04/09] GET /log — le journal du moteur, a la demande, en texte brut.
        // Remplace le fichier ecrit d'office a chaque demarrage : le navigateur
        // vient chercher les N dernieres lignes quand on les lui demande, et
        // rien ne s'accumule sur le disque entre-temps.
        // Contrat, cote client (medusaLogPull dans nasscad_logs.js) :
        //   text/plain, une ligne par ligne, la plus recente en dernier,
        //   ?n=<max> pour borner (defaut 2000, n=0 = tout le tampon).
        // Les en-tetes CORS sont deja poses par sendResponse, comme pour /ping.
        else if (req.method == "GET" && (req.path == "/log" || req.path.rfind("/log?", 0) == 0)) {
            size_t n = 2000;
            const size_t q = req.path.find("n=");
            if (q != std::string::npos) {
                const long v = std::atol(req.path.c_str() + q + 2);
                if (v >= 0) n = (size_t)v;          // n=0 -> tout
            }
            const std::string body = logRingDump(n);
            sendResponse(fd, 200, "OK", "text/plain; charset=utf-8", body.data(), body.size());
        }
        else if (req.method == "POST" && (req.path == "/stepstream" || req.path.rfind("/stepstream?", 0) == 0)) {
            // Mode streaming : headers chunked immediats, puis une frame par mesh
            // AU FIL de la tessellation — le navigateur peut construire et afficher
            // chaque corps sans attendre la fin du calcul complet.
            std::string head =
                "HTTP/1.1 200 OK\r\n"
                + std::string(CORS_HEADERS) +
                "Content-Type: application/octet-stream\r\n"
                "Transfer-Encoding: chunked\r\n"
                "Connection: close\r\n\r\n";
            writeAll(fd, head.data(), head.size());
            // [17/09] Ce chemin ignorait toute la query — donc impossible d'y
            // regler quoi que ce soit, alors que c'est LE chemin qu'emprunte
            // NASSCAD par defaut (cf. _readStepFileViaBoosterStream cote client).
            const double ssDeflection = parseQueryTuning(req.path);
            logStepFileBanner(req.body, "/stepstream");   // [28/08] nom du fichier importe
            try {
                double tessMs = 0; int faceCount = 0; int sent = 0;
                auto t0 = Clock::now();
                // [24/09, soir] ?tag= : empreinte du fichier, cf. ImportEntry.
                processStepBuffer(req.body, ssDeflection, tessMs, faceCount,
                    [&](const MeshData& m){ writeMeshFrame(fd, m); sent++; },
                    fileTagFromQuery(req.path));
                std::ostringstream fin;
                fin << "{\"end\":true,\"meshCount\":" << sent << ",\"tessMs\":" << tessMs
                    << "," << weldMetaJson() << "}";
                writeJsonFrame(fd, fin.str());
                endChunks(fd);
                auto t1 = Clock::now();
                std::cerr << cInfo() << "[POST /stepstream]" << cReset() << " " << (req.body.size()/1024.0) << " KB STEP -> "
                          << sent << " mesh(es) streamed, " << faceCount << " faces, "
                          << ms(t0,t1) << " ms total\n";
                std::cerr << cInfo() << "[MEM]" << cReset() << " " << memorySummary() << "\n";
            } catch (const std::exception& e) {
                // Trop tard pour un statut HTTP propre (headers 200 deja partis) :
                // frame d'erreur terminale, le client la detecte et bascule sur /step.
                std::ostringstream err;
                err << "{\"end\":true,\"error\":\"" << jsonEscape(e.what()) << "\"}";
                writeJsonFrame(fd, err.str());
                endChunks(fd);
                std::cerr << cErr() << "[POST /stepstream] ERROR:" << cReset() << " " << e.what() << "\n";
            } catch (...) {
                writeJsonFrame(fd, "{\"end\":true,\"error\":\"non-standard exception\"}");
                endChunks(fd);
                std::cerr << cErr() << "[POST /stepstream] non-standard ERROR" << cReset() << "\n";
            }
        }
        else if (req.method == "POST" && (req.path == "/csg" || req.path.rfind("/csg?", 0) == 0)) {
            // [27/08] La lambda weldMeshForCSG qui vivait ici est passee au scope
            // fichier (juste avant main) : /csgtree en a besoin sur chaque feuille
            // de l arbre. Corps identique, appel identique — voir sa doc la-bas.
            // ─── Boolean CSG natif via Manifold compile en dur (pas WASM) ───────────
            // Protocole requete : [u32 opType 0=union/1=subtract/2=intersect]
            //   [u32 operandCount] puis par operande : [u32 nVert][u32 nTri]
            //   [float32 x nVert*3 positions][uint32 x nTri*3 indices]
            // Reponse : JSON header (jsonLen u32 LE) + positions f32 + indices u32,
            // meme esprit que NSTP.
            try {
                auto t0 = Clock::now();
                const std::string& b = req.body;
                if (b.size() < 8) throw std::runtime_error("/csg request body too short");
                size_t off = 0;
                auto rdU32 = [&](size_t& o)->uint32_t{
                    if (o + 4 > b.size()) throw std::runtime_error("/csg: out-of-bounds read");
                    uint32_t v; std::memcpy(&v, b.data()+o, 4); o += 4; return v;
                };
                uint32_t opType = rdU32(off);
                uint32_t operandCount = rdU32(off);
                if (operandCount < 2) throw std::runtime_error("/csg: at least 2 operands required");
                // [PROTO v2] solidsCount : nombre d'operandes EN TETE de la liste qui
                // forment la cible (a unioner ENTRE EUX avant la soustraction), le
                // reste (operandCount - solidsCount) etant les trous a soustraire.
                // =1 : cas historique, une seule cible (bouton Subtract explicite,
                // ou union/intersect ou solidsCount n'est pas utilise). >1 : plusieurs
                // solides selectionnes en meme temps que des trous cote client
                // (_hasMix) — AVANT ce champ, seul operand[0] etait traite comme
                // cible et tout operand[1..] (solides additionnels inclus) etait
                // soustrait comme un trou, faisant disparaitre silencieusement tout
                // solide au-dela du premier au lieu de le fusionner dans le resultat.
                uint32_t solidsCount = rdU32(off);
                if (opType == 1 && (solidsCount < 1 || solidsCount >= operandCount))
                    throw std::runtime_error("/csg: invalid solidsCount for subtract (must be in [1, operandCount-1])");
                // Plus de cap metier (l'ancien "500 safety cap" est saute : les
                // workers CSG sont deportes sur MEDUSA, c'est lui qui encaisse).
                // Seule reste une borne de COHERENCE protocolaire : chaque operande
                // occupe au minimum 8 octets (headers nVert/nTri), donc un
                // operandCount superieur a bodySize/8 est forcement un u32 corrompu
                // — pas une vraie requete. Les vraies limites physiques (RAM) sont
                // deja couvertes par les checks "truncated operand" plus bas.
                if ((size_t)operandCount > b.size() / 8) throw std::runtime_error("/csg: operandCount inconsistent with request size (corrupt header)");

                ManifoldArena manMem; // buffers des operandes — liberes ET detruits a la sortie du bloc
                std::vector<ManifoldManifold*> operands;
                // Stockage a duree de requete pour les meshes soudes (voir weldMeshForCSG) : les
                // ManifoldMeshGL construits ci-dessous referencent ces buffers directement, ils
                // doivent rester valides jusqu'au manifold_boolean tout en bas.
                std::vector<std::vector<float>> operandBuffers;
                std::vector<std::vector<uint32_t>> operandIdxBuffers;
                // [21/09] RELEVE DES OPERANDES FAUTIFS.
                // Le 21/09 a 11:43:48, une union de 214 corps a rendu
                // isEmpty=true, manifold=false, genus=1 sur un maillage a 0
                // sommet — autrement dit un objet en etat d'erreur, pas un
                // resultat. Un seul operande invalide empoisonne tout le batch,
                // et le journal ne disait pas lequel : il disait "Manifold will
                // try anyway". C'est ce silence qu'on corrige. Chaque operande
                // refuse est identifie, CLASSE (arete nue / sur-valencee /
                // sommet papillon — ce que le code de statut de Manifold ne dit
                // pas), journalise, et renvoye au client dans la reponse.
                struct BadOperand { uint32_t i; int status; int naked, over, bowtie; };
                std::vector<BadOperand> badOperands;
                // Barre CSG — meme famille que PARSING/RESOLUTION/TESSELLATION :
                // mono-thread (cette boucle tourne avant tout parallelisme), donc
                // pas besoin de gConsoleMutex ici. Les anciens logs "welded"/
                // "status=" par operande partaient en clair sur la console a
                // chaque iteration (std::cerr direct) et empechaient toute barre
                // de rester stable, exactement le meme symptome que COLOR avant
                // le fix RESOLUTION -- donc meme remede : logFileOnly (visibles
                // dans medusa.log, plus sur la console) + une barre qui avance.
                barPhaseStart();
                for (uint32_t i = 0; i < operandCount; i++) {
                    uint32_t nVert = rdU32(off), nTri = rdU32(off);
                    size_t vBytes = (size_t)nVert * 3 * 4, iBytes = (size_t)nTri * 3 * 4;
                    if (off + vBytes + iBytes > b.size()) throw std::runtime_error("/csg: truncated operand");
                    const float* vp = reinterpret_cast<const float*>(b.data() + off); off += vBytes;
                    const uint32_t* ip = reinterpret_cast<const uint32_t*>(b.data() + off); off += iBytes;

                    // Copie modifiable pour la soudure (le buffer requete original reste const).
                    std::vector<float> wPos(vp, vp + nVert * 3);
                    std::vector<uint32_t> wIdx(ip, ip + nTri * 3);
                    size_t vertBefore = wPos.size() / 3;
                    weldMeshForCSG(wPos, wIdx);
                    if (wPos.size() / 3 != vertBefore) {
                        std::ostringstream oss;
                        oss << "  CSG: operand " << i << " welded (" << vertBefore << " -> "
                            << (wPos.size()/3) << " vertices, UV seam duplicates merged)\n";
                        logFileOnly(oss.str());
                    }
                    // wPos/wIdx doivent survivre jusqu'a l'appel manifold_boolean (Manifold ne copie
                    // pas forcement les donnees a la construction) -> stockage a duree de requete.
                    operandBuffers.push_back(std::move(wPos));
                    operandIdxBuffers.push_back(std::move(wIdx));
                    auto& fPos = operandBuffers.back();
                    auto& fIdx = operandIdxBuffers.back();

                    ManifoldMeshGL* mg = manMem.make(manifold_meshgl_size(), [&](void* p){
                        return manifold_meshgl(p, fPos.data(), fPos.size()/3, 3,
                                               fIdx.data(), fIdx.size()/3); });
                    ManifoldManifold* m = manMem.make(manifold_manifold_size(), [&](void* p){
                        return manifold_of_meshgl(p, mg); });
                    if (manifold_status(m) != MANIFOLD_NO_ERROR) {
                        // Classement du defaut. Ne coute rien sur le chemin sain :
                        // on n'analyse QUE les operandes que Manifold a deja refuses.
                        int nk = 0, ov = 0, bt = 0;
                        nasweld::analyzeTopology(fIdx, (uint32_t)(fPos.size() / 3), nk, ov, bt);
                        badOperands.push_back(BadOperand{ i, (int)manifold_status(m), nk, ov, bt });
                        std::ostringstream oss;
                        oss << "  CSG: operand " << i << " REFUSE par Manifold (status="
                            << (int)manifold_status(m) << ") — naked=" << nk
                            << " over-valenced=" << ov << " bowtie=" << bt
                            << " (" << (fIdx.size()/3) << " tris, " << (fPos.size()/3) << " verts)\n";
                        logFileOnly(oss.str());
                    }
                    operands.push_back(m);

                    // Throttlee comme RESOLUTION : un pourcentage entier a la fois,
                    // plus toujours la derniere iteration (garantit 100% affiche).
                    int pct = (int)(100.0 * (i + 1) / operandCount);
                    int prevPct = (int)(100.0 * i / operandCount);
                    if (pct != prevPct || (i + 1) == operandCount) {
                        drawBarLine("CSG", (double)(i + 1) / operandCount,
                            std::to_string(pct) + "%  (" + std::to_string(i + 1) + "/" + std::to_string(operandCount) + ")");
                    }
                }

                // [PERF 30/08] Le corps de requete est MORT a partir d'ici : chaque
                // operande a ete copie dans operandBuffers (copie modifiable exigee
                // par la soudure, le corps etant const). Le laisser alloue le fait
                // vivre pendant TOUT le calcul Manifold -- c'est-a-dire exactement
                // au pic memoire, ou coexistent deja : les operandes soudes, la
                // representation interne Manifold, puis le resultat. Sur une union
                // de gros maillages, c'est une copie pleine de l'entree gardee pour
                // rien au pire moment. Verifie avant retrait : plus une seule
                // lecture de req.body au-dela de ce point dans ce handler.
                req.body.clear();
                req.body.shrink_to_fit();

                ManifoldOpType mop = opType == 0 ? MANIFOLD_ADD : opType == 1 ? MANIFOLD_SUBTRACT : MANIFOLD_INTERSECT;

                // ?legacy=1 : repli sur l'ancien fold sequentiel pur, uniquement pour
                // comparaison A/B directe (meme requete, meme machine) avec le chemin
                // batch ci-dessous -- voir POST /csg?legacy=1.
                bool legacyFold = false;
                {
                    auto qpos2 = req.path.find('?');
                    if (qpos2 != std::string::npos) {
                        legacyFold = req.path.substr(qpos2 + 1).find("legacy=1") != std::string::npos;
                    }
                }

                // Declaree APRES manMem : detruite avant elle a la sortie du bloc,
                // donc un intermediaire ne survit jamais a l'operande qui l'a produit.
                ManifoldArena resultMem;
                ManifoldManifold* result;

                if (legacyFold) {
                    // ── Ancien chemin : fold sequentiel A puis B puis C... aucun
                    // parallelisme, aucun tri par taille. Conserve uniquement pour
                    // mesurer le delta reel face au chemin batch (meme session).
                    // NE respecte PAS solidsCount (fold naif, operand[0] en tete) --
                    // sans consequence : chemin debug opt-in (?legacy=1), jamais
                    // emprunte par le client par defaut. ──
                    result = operands[0];
                    for (size_t i = 1; i < operands.size(); i++) {
                        ManifoldManifold* acc = result;
                        result = resultMem.make(manifold_manifold_size(), [&](void* p){
                            return manifold_boolean(p, acc, operands[i], mop); });
                    }
                } else if (opType == 1) {
                    // ── Subtract : non-commutatif, manifold_batch_boolean ne le supporte
                    // pas (assert cote lib -- Union/Intersect seulement). Mais l'identite
                    // ensembliste (S1∪S2∪..) - (H1∪H2∪..) tient toujours : on batch-union
                    // les solides (operand[0..solidsCount-1]) pour former la cible reelle,
                    // on batch-union les trous (operand[solidsCount..end], ca c'est
                    // commutatif et parallelisable), puis UNE seule soustraction finale
                    // cible − trous. ──
                    ManifoldManifold* target;
                    if (solidsCount > 1) {
                        ManifoldManifoldVec* solidVec = resultMem.make(manifold_manifold_vec_size(),
                            [&](void* p){ return manifold_manifold_empty_vec(p); });
                        for (size_t i = 0; i < solidsCount; i++) manifold_manifold_vec_push_back(solidVec, operands[i]);
                        target = resultMem.make(manifold_manifold_size(), [&](void* p){
                            return manifold_batch_boolean(p, solidVec, MANIFOLD_ADD); });
                    } else {
                        target = operands[0]; // cas historique : une seule cible
                    }

                    ManifoldManifoldVec* subVec = resultMem.make(manifold_manifold_vec_size(),
                        [&](void* p){ return manifold_manifold_empty_vec(p); });
                    for (size_t i = solidsCount; i < operands.size(); i++) manifold_manifold_vec_push_back(subVec, operands[i]);

                    ManifoldManifold* subtrahends = resultMem.make(manifold_manifold_size(), [&](void* p){
                        return manifold_batch_boolean(p, subVec, MANIFOLD_ADD); });

                    result = resultMem.make(manifold_manifold_size(), [&](void* p){
                        return manifold_boolean(p, target, subtrahends, MANIFOLD_SUBTRACT); });
                } else {
                    // ── Union / Intersect : commutatifs -> manifold_batch_boolean natif
                    // (Manifold::BatchBoolean, src/csg_tree.cpp). Deux gains empiles sans
                    // code maison : (1) tri par taille croissante -- fusionne les petits
                    // maillages en premier, moins de copie/traitement ; (2) des que la lib
                    // est compilee avec MANIFOLD_PAR=1 (deja le cas, build_manifold.sh
                    // -DMANIFOLD_PAR=ON), un tbb::task_group traite 4 paires a la fois en
                    // parallele reel, sans thread-pool maison ni risque de sur-souscription
                    // (c'est TBB qui gere son propre pool global). ──
                    ManifoldManifoldVec* vec = resultMem.make(manifold_manifold_vec_size(),
                        [&](void* p){ return manifold_manifold_empty_vec(p); });
                    for (auto* o : operands) manifold_manifold_vec_push_back(vec, o);

                    result = resultMem.make(manifold_manifold_size(), [&](void* p){
                        return manifold_batch_boolean(p, vec, mop); });
                }

                double volume = manifold_volume(result);
                int status = (int)manifold_status(result);
                // [PERF 18/08] manifold_num_vert(result)/manifold_num_tri(result)
                // retires : leur resultat (nVertOut/nTriOut) n'etait jamais lu — le
                // JSON de reponse et les tailles de buffer plus bas utilisent deja
                // outNV/outNT, obtenus via manifold_meshgl_num_vert/tri sur le
                // meshgl extrait juste en dessous. Deux appels bibliotheque morts en
                // moins par requete /csg (confirme mort par le compilateur lui-meme,
                // -Wunused-variable sur les deux, avant ce retrait).

                // [MANIFOLD-CALC] Trois grandeurs deja disponibles sur le solide
                // resultat, sans nouveau maillage ni cout notable (Manifold les
                // tient a jour en interne pendant le boolean), jusqu'ici jetees :
                //  - surfaceArea : pendant naturel de volume (manifold_surface_area,
                //    meme signature) -- utile cote UI pour un calcul de matiere/
                //    surface a peindre, etc.
                //  - isEmpty (manifold_is_empty) : distingue explicitement un
                //    resultat VIDE (ex. Subtract qui consomme entierement la
                //    cible) d'un vrai succes -- avant ce champ le client recevait
                //    success:true, vertCount:0 sans moyen de le detecter sans
                //    deviner sur outNV cote JS.
                //  - genus (manifold_genus, caracteristique d'Euler V-E+F) :
                //    indicateur bon marche de topologie cassee, INDEPENDANT de
                //    "status" (qui ne capte que les erreurs internes Manifold, pas
                //    un resultat degenere mais structurellement "valide" a ses yeux).
                double surfaceArea = manifold_surface_area(result);
                bool isEmpty = manifold_is_empty(result) != 0;
                int genus = manifold_genus(result);
                if (isEmpty) {
                    logFileOnly("  CSG: empty result (isEmpty=true) -- solid entirely consumed by the operation\n");
                    // [21/09] La phrase qui manquait au journal du 21/09.
                    if (!badOperands.empty()) {
                        std::ostringstream oss;
                        oss << "  CSG: CAUSE PROBABLE — " << badOperands.size() << " operande(s) sur "
                            << operandCount << " etaient DEJA invalides avant la booleenne ; un seul suffit "
                               "a empoisonner manifold_batch_boolean. Indices :";
                        for (size_t q = 0; q < badOperands.size() && q < 40; ++q)
                            oss << " " << badOperands[q].i;
                        if (badOperands.size() > 40) oss << " ... (+" << (badOperands.size() - 40) << ")";
                        oss << "\n";
                        logFileOnly(oss.str());
                    }
                }

                ManifoldMeshGL* outMesh = resultMem.make(manifold_meshgl_size(), [&](void* p){
                    return manifold_get_meshgl(p, result); });
                size_t outNV = manifold_meshgl_num_vert(outMesh), outNT = manifold_meshgl_num_tri(outMesh);

                float*    vertBuf = manifold_meshgl_vert_properties(resultMem.raw(sizeof(float) * outNV * 3), outMesh);
                uint32_t* triBuf  = manifold_meshgl_tri_verts(resultMem.raw(sizeof(uint32_t) * outNT * 3), outMesh);

                auto t1 = Clock::now();
                double csgMs = ms(t0, t1);

                std::ostringstream json;
                json << "{\"success\":true,\"vertCount\":" << outNV << ",\"triCount\":" << outNT
                     << ",\"volume\":" << volume << ",\"surfaceArea\":" << surfaceArea
                     << ",\"manifold\":" << (status == 0 ? "true" : "false")
                     << ",\"isEmpty\":" << (isEmpty ? "true" : "false") << ",\"genus\":" << genus
                     // [21/09] Champs ADDITIFS, bornes a 32 entrees : le client
                     // doit pouvoir NOMMER les corps fautifs, pas afficher un
                     // echec anonyme. L'index renvoye est celui de l'operande
                     // dans la requete, donc directement remontable a l'objet
                     // de la scene cote client.
                     << ",\"badOperandCount\":" << badOperands.size()
                     << ",\"badOperands\":" << [&]{
                            std::ostringstream a; a << "[";
                            for (size_t q = 0; q < badOperands.size() && q < 32; ++q) {
                                if (q) a << ",";
                                a << "{\"i\":" << badOperands[q].i
                                  << ",\"status\":" << badOperands[q].status
                                  << ",\"naked\":" << badOperands[q].naked
                                  << ",\"over\":" << badOperands[q].over
                                  << ",\"bowtie\":" << badOperands[q].bowtie << "}";
                            }
                            a << "]"; return a.str(); }()
                     << ",\"csgMs\":" << csgMs << ",\"operandCount\":" << operandCount << "}";
                std::string js = json.str();
                uint32_t jl = (uint32_t)js.size();
                size_t vB = outNV * 3 * 4, iB = outNT * 3 * 4;
                // [PERF 30/08] Reponse STREAMEE au lieu d'un tampon unique.
                // Avant : un std::vector<uint8_t> de (JSON + positions + indices) etait
                // alloue puis rempli par memcpy -- une copie pleine du resultat, en vie
                // en meme temps que les tampons Manifold dont elle est copiee. On emet
                // maintenant directement depuis ces tampons, en chunked (RFC 7230), avec
                // l'infrastructure deja utilisee par /stepstream.
                // Cote client : fetch() reassemble le chunked de facon transparente et
                // res.arrayBuffer() rend exactement les memes octets, dans le meme ordre
                // -- AUCUN changement navigateur. La mise en chunked n'a lieu qu'ICI,
                // apres le calcul reussi : tous les chemins d'erreur passent avant et
                // gardent leur sendResponse(500) classique avec ses en-tetes.
                {
                    std::string head =
                        "HTTP/1.1 200 OK\r\n"
                        + std::string(CORS_HEADERS) +
                        "Content-Type: application/octet-stream\r\n"
                        "Transfer-Encoding: chunked\r\n"
                        "Connection: close\r\n\r\n";
                    writeAll(fd, head.data(), head.size());
                    uint8_t lenLE[4] = { (uint8_t)(jl & 0xFF), (uint8_t)((jl >> 8) & 0xFF),
                                         (uint8_t)((jl >> 16) & 0xFF), (uint8_t)((jl >> 24) & 0xFF) };
                    writeChunk(fd, lenLE, 4);
                    writeChunk(fd, (const uint8_t*)js.data(), jl);
                    if (vB) writeChunk(fd, (const uint8_t*)vertBuf, vB);
                    if (iB) writeChunk(fd, (const uint8_t*)triBuf, iB);
                    endChunks(fd);
                }
                std::cerr << cInfo() << "[POST /csg]" << cReset() << " " << operandCount << " operand(s), op=" << opType
                          << (legacyFold ? " [legacy fold]" : " [batch]")
                          << " -> " << outNV << " verts, " << outNT << " tris, volume=" << volume
                          << ", area=" << surfaceArea << (isEmpty ? ", EMPTY" : "")
                          << ", " << csgMs << " ms\n";

            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /csg] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (Manifold?)\"}";
                std::cerr << cErr() << "[POST /csg] non-standard ERROR" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        else if (req.method == "POST" && (req.path == "/csgtree" || req.path.rfind("/csgtree?", 0) == 0)) {
            // ─── Arbre CSG natif — voir la doc du protocole au-dessus de main() ──
            // Remplace _workerCSGTree (Manifold WASM) : l arbre entier en UNE
            // requete, evalue en post-ordre, intermediaires gardes vivants entre
            // niveaux, une seule extraction meshgl a la racine.
            try {
                auto t0 = Clock::now();
                const std::string& b = req.body;
                if (b.size() < 12) throw std::runtime_error("/csgtree request body too short");
                size_t off = 0;
                uint32_t magic; std::memcpy(&magic, b.data(), 4); off = 4;
                if (magic != 0x45525443u) throw std::runtime_error("/csgtree: bad magic (expected 'CTRE')");
                uint32_t ver; std::memcpy(&ver, b.data()+off, 4); off += 4;
                if (ver != 1u) throw std::runtime_error("/csgtree: unsupported protocol version");

                CsgTreeNode root;
                uint32_t nodeCount = 0, leafCount = 0;
                parseCsgTreeNode(b, off, root, 0, nodeCount, leafCount);

                // [PERF 30/08] Le corps de requete est MORT a partir d'ici : chaque
                // feuille de l'arbre possede ses propres vecteurs pos/idx (copies
                // faites par parseCsgTreeNode). Le laisser alloue le fait
                // vivre pendant TOUT le calcul Manifold -- c'est-a-dire exactement
                // au pic memoire, ou coexistent deja : les operandes soudes, la
                // representation interne Manifold, puis le resultat. Sur une union
                // de gros maillages, c'est une copie pleine de l'entree gardee pour
                // rien au pire moment. Verifie avant retrait : plus une seule
                // lecture de req.body au-dela de ce point dans ce handler.
                req.body.clear();
                req.body.shrink_to_fit();

                if (root.leaf) throw std::runtime_error("/csgtree: root must be an internal node (nothing to evaluate)");

                // ── Soudure des feuilles en parallele — meme pool artisanal que
                // /smooth (compteur atomique + threads bornes aux coeurs et au
                // nombre de feuilles). C est du C++ pur sur des buffers disjoints,
                // aucun etat partage, aucune API Manifold touchee ici.
                std::vector<CsgTreeNode*> leaves;
                collectCsgTreeLeaves(root, leaves);
                if (leaves.empty()) throw std::runtime_error("/csgtree: no leaf mesh in tree");
                {
                    unsigned nThreads = std::thread::hardware_concurrency();
                    if (nThreads == 0) nThreads = 4;
                    nThreads = (unsigned)std::min((size_t)nThreads, leaves.size());
                    std::atomic<uint32_t> nextIdx{0};
                    std::atomic<uint32_t> weldDone{0};
                    uint32_t lastDrawnWeld = 0;
                    std::exception_ptr firstErr = nullptr;
                    std::mutex errMutex;
                    const uint32_t nLeaves = (uint32_t)leaves.size();
                    barPhaseStart();
                    std::vector<std::thread> pool;
                    pool.reserve(nThreads);
                    for (unsigned t = 0; t < nThreads; t++) {
                        pool.emplace_back([&]() {
                            for (;;) {
                                uint32_t i = nextIdx.fetch_add(1);
                                if (i >= nLeaves) break;
                                try {
                                    weldMeshForCSG(leaves[i]->pos, leaves[i]->idx);
                                } catch (...) {
                                    std::lock_guard<std::mutex> lk(errMutex);
                                    if (!firstErr) firstErr = std::current_exception();
                                }
                                uint32_t done = weldDone.fetch_add(1) + 1;
                                std::lock_guard<std::mutex> lk(gConsoleMutex);
                                if (done > lastDrawnWeld) {
                                    int pct = (int)(100.0 * done / nLeaves);
                                    int prevPct = (int)(100.0 * lastDrawnWeld / nLeaves);
                                    if (pct != prevPct || done == nLeaves) {
                                        drawBarLine("CSGTREE", (double)done / nLeaves,
                                            std::to_string(pct) + "%  (" + std::to_string(done) + "/" + std::to_string(nLeaves) + " leaves)");
                                    }
                                    lastDrawnWeld = done;
                                }
                            }
                        });
                    }
                    for (auto& th : pool) th.join();
                    if (firstErr) std::rethrow_exception(firstErr);
                }

                ManifoldArena mem; // tous les buffers Manifold — liberes ET detruits a la sortie du bloc
                ManifoldManifold* result = evalCsgTreeNode(root, mem);

                double volume = manifold_volume(result);
                int status = (int)manifold_status(result);
                // [MANIFOLD-CALC] Memes trois grandeurs additionnelles qu'en /csg
                // (voir le commentaire detaille la-bas) : surfaceArea, isEmpty,
                // genus -- deja tenues a jour par Manifold sur "result", jamais
                // lues jusqu'ici sur ce chemin /csgtree non plus.
                double surfaceArea = manifold_surface_area(result);
                bool isEmpty = manifold_is_empty(result) != 0;
                int genus = manifold_genus(result);
                if (isEmpty) {
                    logFileOnly("  CSGTREE: empty result (isEmpty=true) -- tree entirely consumed\n");
                }

                ManifoldMeshGL* outMesh = mem.make(manifold_meshgl_size(), [&](void* p){
                    return manifold_get_meshgl(p, result); });
                size_t outNV = manifold_meshgl_num_vert(outMesh), outNT = manifold_meshgl_num_tri(outMesh);

                float*    vertBuf = manifold_meshgl_vert_properties(mem.raw(sizeof(float) * outNV * 3), outMesh);
                uint32_t* triBuf  = manifold_meshgl_tri_verts(mem.raw(sizeof(uint32_t) * outNT * 3), outMesh);

                auto t1 = Clock::now();
                double csgMs = ms(t0, t1);

                // Cadre de reponse IDENTIQUE a /csg (le client partage le decodeur).
                // csgMs porte le meme nom pour la meme raison.
                std::ostringstream json;
                json << "{\"success\":true,\"vertCount\":" << outNV << ",\"triCount\":" << outNT
                     << ",\"volume\":" << volume << ",\"surfaceArea\":" << surfaceArea
                     << ",\"manifold\":" << (status == 0 ? "true" : "false")
                     << ",\"isEmpty\":" << (isEmpty ? "true" : "false") << ",\"genus\":" << genus
                     << ",\"csgMs\":" << csgMs << ",\"nodeCount\":" << nodeCount
                     << ",\"leafCount\":" << leafCount << "}";
                std::string js = json.str();
                uint32_t jl = (uint32_t)js.size();
                size_t vB = outNV * 3 * 4, iB = outNT * 3 * 4;
                // [PERF 30/08] Reponse STREAMEE au lieu d'un tampon unique.
                // Avant : un std::vector<uint8_t> de (JSON + positions + indices) etait
                // alloue puis rempli par memcpy -- une copie pleine du resultat, en vie
                // en meme temps que les tampons Manifold dont elle est copiee. On emet
                // maintenant directement depuis ces tampons, en chunked (RFC 7230), avec
                // l'infrastructure deja utilisee par /stepstream.
                // Cote client : fetch() reassemble le chunked de facon transparente et
                // res.arrayBuffer() rend exactement les memes octets, dans le meme ordre
                // -- AUCUN changement navigateur. La mise en chunked n'a lieu qu'ICI,
                // apres le calcul reussi : tous les chemins d'erreur passent avant et
                // gardent leur sendResponse(500) classique avec ses en-tetes.
                {
                    std::string head =
                        "HTTP/1.1 200 OK\r\n"
                        + std::string(CORS_HEADERS) +
                        "Content-Type: application/octet-stream\r\n"
                        "Transfer-Encoding: chunked\r\n"
                        "Connection: close\r\n\r\n";
                    writeAll(fd, head.data(), head.size());
                    uint8_t lenLE[4] = { (uint8_t)(jl & 0xFF), (uint8_t)((jl >> 8) & 0xFF),
                                         (uint8_t)((jl >> 16) & 0xFF), (uint8_t)((jl >> 24) & 0xFF) };
                    writeChunk(fd, lenLE, 4);
                    writeChunk(fd, (const uint8_t*)js.data(), jl);
                    if (vB) writeChunk(fd, (const uint8_t*)vertBuf, vB);
                    if (iB) writeChunk(fd, (const uint8_t*)triBuf, iB);
                    endChunks(fd);
                }
                std::cerr << cInfo() << "[POST /csgtree]" << cReset() << " " << nodeCount << " node(s), "
                          << leafCount << " leaf/leaves -> " << outNV << " verts, " << outNT
                          << " tris, volume=" << volume << ", area=" << surfaceArea
                          << (isEmpty ? ", EMPTY" : "") << ", " << csgMs << " ms\n";

            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /csgtree] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (Manifold tree?)\"}";
                std::cerr << cErr() << "[POST /csgtree] non-standard ERROR" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        else if (req.method == "POST" && (req.path == "/smooth" || req.path.rfind("/smooth?", 0) == 0)) {
            // ─── Lissage BFS natif, EN LOT ET EN PARALLELE ────────────────
            // Cible directe du goulot mesure sur import STEP multi-corps :
            // N corps INDEPENDANTS (contrairement au CSG, aucune dependance
            // croisee entre eux) traites un thread par coeur, au lieu de
            // sequentiellement dans l'unique Worker JS Postprocess.
            // Protocole requete : [f32 creaseAngleDeg][u32 meshCount] puis
            // par mesh : [u32 nVert][u32 nTri][f32 x nVert*3 positions]
            // [u32 x nTri*3 indices].
            // Reponse : JSON header (jsonLen u32 LE, counts[] = nb de
            // vertices EN SORTIE par mesh, non-indexe) puis, par mesh dans
            // l'ordre, positions f32 + normales f32 concatenees.
            try {
                auto t0 = Clock::now();
                const std::string& b = req.body;
                if (b.size() < 8) throw std::runtime_error("/smooth request body too short");
                size_t off = 0;
                auto rdU32 = [&](size_t& o)->uint32_t{
                    if (o + 4 > b.size()) throw std::runtime_error("/smooth: out-of-bounds read");
                    uint32_t v; std::memcpy(&v, b.data()+o, 4); o += 4; return v;
                };
                auto rdF32 = [&](size_t& o)->float{
                    if (o + 4 > b.size()) throw std::runtime_error("/smooth: out-of-bounds read");
                    float v; std::memcpy(&v, b.data()+o, 4); o += 4; return v;
                };
                float creaseDeg = rdF32(off);
                uint32_t meshCount = rdU32(off);
                if (meshCount < 1) throw std::runtime_error("/smooth: at least 1 mesh required");
                // Borne de coherence protocolaire (meme esprit que /csg) : chaque
                // mesh occupe au moins 8 octets de header (nVert+nTri).
                if ((size_t)meshCount > b.size() / 8) throw std::runtime_error("/smooth: meshCount inconsistent with request size (corrupt header)");
                static constexpr double PI_LOCAL = 3.14159265358979323846;
                double cosCrease = std::cos(creaseDeg * PI_LOCAL / 180.0);

                std::vector<std::vector<float>> inPos(meshCount);
                std::vector<std::vector<uint32_t>> inIdx(meshCount);
                for (uint32_t m = 0; m < meshCount; m++) {
                    uint32_t nVert = rdU32(off), nTri = rdU32(off);
                    size_t vBytes = (size_t)nVert * 3 * 4, iBytes = (size_t)nTri * 3 * 4;
                    if (off + vBytes + iBytes > b.size()) throw std::runtime_error("/smooth: truncated mesh");
                    const float* vp = reinterpret_cast<const float*>(b.data() + off); off += vBytes;
                    const uint32_t* ip = reinterpret_cast<const uint32_t*>(b.data() + off); off += iBytes;
                    inPos[m].assign(vp, vp + (size_t)nVert * 3);
                    inIdx[m].assign(ip, ip + (size_t)nTri * 3);
                }

                // ── Parallelisation : chaque mesh est independant, un pool
                // de threads (borne au nb de coeurs ET au nb de meshes) tire
                // les indices restants via un compteur atomique partage ──
                std::vector<SmoothResult> results(meshCount);
                std::exception_ptr firstErr = nullptr;
                std::mutex errMutex;
                unsigned nThreads = std::thread::hardware_concurrency();
                if (nThreads == 0) nThreads = 4; // hardware_concurrency() peut renvoyer 0, filet de secu
                nThreads = (unsigned)std::min((size_t)nThreads, (size_t)meshCount);
                std::atomic<uint32_t> nextIdx{0};
                // Barre SMOOTH — meme technique que TESSELLATION (voir processStepBuffer) :
                // compteur atomique de completion + gConsoleMutex + lastDrawn qui ne recule
                // jamais, throttlee aux paliers de 1%. Ordre de completion non deterministe
                // entre threads, donc on affiche l'avancement global, pas "le mesh en cours".
                std::atomic<uint32_t> smoothDone{0};
                uint32_t lastDrawnSmooth = 0;
                barPhaseStart();
                std::vector<std::thread> pool;
                pool.reserve(nThreads);
                for (unsigned t = 0; t < nThreads; t++) {
                    pool.emplace_back([&]() {
                        for (;;) {
                            uint32_t m = nextIdx.fetch_add(1);
                            if (m >= meshCount) break;
                            try {
                                results[m] = smoothMeshBFSLocal(std::move(inPos[m]), std::move(inIdx[m]), cosCrease);
                            } catch (...) {
                                std::lock_guard<std::mutex> lk(errMutex);
                                if (!firstErr) firstErr = std::current_exception();
                            }
                            uint32_t done = smoothDone.fetch_add(1) + 1;
                            std::lock_guard<std::mutex> lk(gConsoleMutex);
                            if (done > lastDrawnSmooth) {
                                int pct = (int)(100.0 * done / meshCount);
                                int prevPct = (int)(100.0 * lastDrawnSmooth / meshCount);
                                if (pct != prevPct || done == meshCount) {
                                    drawBarLine("SMOOTH", (double)done / meshCount,
                                        std::to_string(pct) + "%  (" + std::to_string(done) + "/" + std::to_string(meshCount) + ")");
                                }
                                lastDrawnSmooth = done;
                            }
                        }
                    });
                }
                for (auto& th : pool) th.join();
                if (firstErr) std::rethrow_exception(firstErr);

                auto t1 = Clock::now();
                double smoothMs = ms(t0, t1);

                std::ostringstream json;
                json << "{\"success\":true,\"meshCount\":" << meshCount << ",\"counts\":[";
                for (uint32_t m = 0; m < meshCount; m++) {
                    if (m) json << ",";
                    json << (results[m].pos.size() / 3);
                }
                json << "],\"idxCounts\":[";
                for (uint32_t m = 0; m < meshCount; m++) {
                    if (m) json << ",";
                    json << results[m].idx.size();
                }
                json << "],\"smoothMs\":" << smoothMs << "}";
                std::string js = json.str();
                uint32_t jl = (uint32_t)js.size();

                size_t totalBinBytes = 0, totalInFaces = 0, totalOutVerts = 0;
                for (auto& r : results) {
                    totalBinBytes += r.pos.size() * 4 + r.nrm.size() * 4 + r.idx.size() * 4;
                    totalInFaces += r.idx.size() / 3;
                    totalOutVerts += r.pos.size() / 3;
                }
                std::vector<uint8_t> out(4 + jl + totalBinBytes);
                out[0]=jl&0xFF; out[1]=(jl>>8)&0xFF; out[2]=(jl>>16)&0xFF; out[3]=(jl>>24)&0xFF;
                std::memcpy(out.data()+4, js.data(), jl);
                size_t wOff = 4 + jl;
                for (auto& r : results) {
                    std::memcpy(out.data()+wOff, r.pos.data(), r.pos.size()*4); wOff += r.pos.size()*4;
                    std::memcpy(out.data()+wOff, r.nrm.data(), r.nrm.size()*4); wOff += r.nrm.size()*4;
                    std::memcpy(out.data()+wOff, r.idx.data(), r.idx.size()*4); wOff += r.idx.size()*4;
                }

                // Taux de reduction reel vs l'ancienne sortie non-indexee (faces*3) —
                // visible immediatement dans la console, pas juste suppose.
                double reduction = totalInFaces > 0 ? (1.0 - (double)totalOutVerts / (double)(totalInFaces * 3)) * 100.0 : 0.0;
                std::cerr << cInfo() << "[POST /smooth]" << cReset() << " " << meshCount << " mesh(es), crease=" << creaseDeg
                          << "deg, " << nThreads << " thread(s) -> " << smoothMs << " ms"
                          << " (indexed output: " << totalOutVerts << " verts vs " << (totalInFaces*3)
                          << " old non-indexed, -" << reduction << "%)\n";

                sendResponse(fd, 200, "OK", "application/octet-stream", (const char*)out.data(), out.size());
            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /smooth] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (smooth)\"}";
                std::cerr << cErr() << "[POST /smooth] non-standard ERROR" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        else if (req.method == "POST" && (req.path == "/repair" || req.path.rfind("/repair?", 0) == 0)) {
            // ─── Repair manifold natif, EN LOT ET EN PARALLELE — mirror de /smooth ──
            // [11/08] Meme diagnostic que /smooth en son temps : mesure sur
            // Scania-Engine-V8-XT-Turbo.step (1297 corps, meme lot), repair
            // sequentiel client (pool 4 workers) = 234.6s vs smooth natif = 17.5s —
            // 13x d'ecart, meme classe de probleme (N corps geometriquement
            // independants). Cf. session Nass 11/08, chiffres [perf-step] mesures.
            //
            // Technique de repair identique au client (_manifoldRepair, step-import.js) :
            // weld (soudure vertices dupliques aux coutures, cf. weldMeshLocal —
            // deja utilisee ailleurs dans ce fichier, meme fonction que weldMeshForCSG
            // dans /csg) puis union d'un mesh avec une COPIE INDEPENDANTE de lui-meme.
            // Le simple weld suffit parfois, mais forcer le corps a travers le
            // pipeline de construction robuste du boolean Manifold repare des cas
            // qu'un check de validite seul ne repare pas — c'est le comportement
            // PROUVE cote client (1292/1297 corps repares avec succes, 2 runs
            // identiques), pas une hypothese : ce handler le reproduit a l'identique,
            // aucune optimisation "skip union si deja propre" — verifiee dangereuse
            // en theorie seulement (impossible de compiler/tester Manifold ici),
            // donc pas prise. Copies A/B strictement separees (pas des alias du
            // meme buffer) : meme prudence memoire que le commentaire /csg plus haut
            // ("Manifold ne copie pas forcement les donnees a la construction").
            //
            // DIFFERENCE CRITIQUE avec /smooth : un corps non-manifold est un
            // resultat NORMAL et FREQUENT ici (~5/1297 sur le fichier de reference),
            // pas une erreur rare. /smooth propage la PREMIERE exception et tue tout
            // le lot (firstErr + rethrow) ; /repair NE FAIT JAMAIS CA — un corps qui
            // echoue son repair retombe sur sa geometrie D'ORIGINE (inchangee,
            // indexee trivialement), exactement le fallback silencieux de
            // _manifoldRepair cote client. Seule une erreur de PROTOCOLE (requete
            // malformee, lecture hors-bornes) fait echouer la requete entiere.
            //
            // Protocole requete : [u32 meshCount] puis par mesh, triangle soup NON
            // indexe (meme forme que ce qu'envoie _manifoldRepair) : [u32 nVert]
            // [f32 x nVert*3 positions] — nTri implicite = nVert/3, indexation
            // triviale 0,1,2... consecutive par construction (pas d'index en entree).
            // Reponse : JSON header (jsonLen u32 LE, counts[]=nVertOut,
            // idxCounts[]=nIdxOut par mesh, repairedCount=nb de corps reellement
            // repares) puis par mesh dans l'ordre : positions f32 + indices u32.
            try {
                auto t0 = Clock::now();
                const std::string& b = req.body;
                if (b.size() < 4) throw std::runtime_error("/repair request body too short");
                size_t off = 0;
                auto rdU32 = [&](size_t& o)->uint32_t{
                    if (o + 4 > b.size()) throw std::runtime_error("/repair: out-of-bounds read");
                    uint32_t v; std::memcpy(&v, b.data()+o, 4); o += 4; return v;
                };
                uint32_t meshCount = rdU32(off);
                if (meshCount < 1) throw std::runtime_error("/repair: at least 1 mesh required");
                // Borne de coherence protocolaire (meme esprit que /smooth et /csg) :
                // chaque mesh occupe au moins 4 octets de header (nVert).
                if ((size_t)meshCount > b.size() / 4) throw std::runtime_error("/repair: meshCount inconsistent with request size (corrupt header)");

                std::vector<std::vector<float>> inPos(meshCount);
                for (uint32_t m = 0; m < meshCount; m++) {
                    uint32_t nVert = rdU32(off);
                    if (nVert % 3 != 0) throw std::runtime_error("/repair: nVert not a multiple of 3 (non-indexed triangle soup expected)");
                    size_t vBytes = (size_t)nVert * 3 * 4;
                    if (off + vBytes > b.size()) throw std::runtime_error("/repair: truncated mesh");
                    const float* vp = reinterpret_cast<const float*>(b.data() + off); off += vBytes;
                    inPos[m].assign(vp, vp + (size_t)nVert * 3);
                }

                // ── Parallelisation : chaque corps est independant, meme pattern
                // pull-based que /smooth (compteur atomique partage) ──
                std::vector<RepairResult> results(meshCount);
                unsigned nThreads = std::thread::hardware_concurrency();
                if (nThreads == 0) nThreads = 4; // hardware_concurrency() peut renvoyer 0, filet de secu
                nThreads = (unsigned)std::min((size_t)nThreads, (size_t)meshCount);
                std::atomic<uint32_t> nextIdx{0};
                std::atomic<uint32_t> repairedCount{0};
                // Barre REPAIR — meme technique que TESSELLATION/SMOOTH : compteur
                // atomique de completion + gConsoleMutex + lastDrawn monotone. Le
                // nombre repare/inchange (repairedCount) est deja calcule pour le
                // JSON final, on le refletra aussi en direct dans le suffixe.
                std::atomic<uint32_t> repairDone{0};
                uint32_t lastDrawnRepair = 0;
                barPhaseStart();
                std::vector<std::thread> pool;
                pool.reserve(nThreads);
                for (unsigned t = 0; t < nThreads; t++) {
                    pool.emplace_back([&]() {
                        for (;;) {
                            uint32_t m = nextIdx.fetch_add(1);
                            if (m >= meshCount) break;

                            const std::vector<float>& srcPos = inPos[m];
                            size_t nVert = srcPos.size() / 3;
                            std::vector<uint32_t> trivialIdx(nVert);
                            for (size_t i = 0; i < nVert; i++) trivialIdx[i] = (uint32_t)i;

                            // Fallback par defaut : geometrie d'origine, indexee
                            // trivialement. Ecrase plus bas UNIQUEMENT si le repair
                            // reussit reellement — un corps recalcitrant n'est jamais
                            // une exception a lever, juste un resultat inchange.
                            results[m].pos = srcPos;
                            results[m].idx = trivialIdx;
                            results[m].repaired = false;

                            ManifoldArena localMem; // libere ET detruit en fin d'iteration, succes ou echec
                            try {
                                // Copies INDEPENDANTES A et B (pas des alias) — meme
                                // prudence que vertsA/vertsB cote client JS.
                                std::vector<float> wPosA = srcPos;
                                std::vector<uint32_t> wIdxA = trivialIdx;
                                weldMeshLocal(wPosA, wIdxA);
                                std::vector<float> wPosB = srcPos;
                                std::vector<uint32_t> wIdxB = trivialIdx;
                                weldMeshLocal(wPosB, wIdxB);

                                ManifoldMeshGL* mgA = localMem.make(manifold_meshgl_size(), [&](void* p){
                                    return manifold_meshgl(p, wPosA.data(), wPosA.size()/3, 3,
                                                           wIdxA.data(), wIdxA.size()/3); });
                                ManifoldManifold* mA = localMem.make(manifold_manifold_size(), [&](void* p){
                                    return manifold_of_meshgl(p, mgA); });

                                ManifoldMeshGL* mgB = localMem.make(manifold_meshgl_size(), [&](void* p){
                                    return manifold_meshgl(p, wPosB.data(), wPosB.size()/3, 3,
                                                           wIdxB.data(), wIdxB.size()/3); });
                                ManifoldManifold* mB = localMem.make(manifold_manifold_size(), [&](void* p){
                                    return manifold_of_meshgl(p, mgB); });

                                ManifoldManifold* result = localMem.make(manifold_manifold_size(), [&](void* p){
                                    return manifold_boolean(p, mA, mB, MANIFOLD_ADD); });

                                if (manifold_status(result) == MANIFOLD_NO_ERROR && manifold_num_vert(result) > 0) {
                                    ManifoldMeshGL* outMesh = localMem.make(manifold_meshgl_size(), [&](void* p){
                                        return manifold_get_meshgl(p, result); });
                                    size_t outNV = manifold_meshgl_num_vert(outMesh), outNT = manifold_meshgl_num_tri(outMesh);
                                    if (outNV > 0 && outNT > 0) {
                                        float*    vertBuf = manifold_meshgl_vert_properties(localMem.raw(sizeof(float) * outNV * 3), outMesh);
                                        uint32_t* triBuf  = manifold_meshgl_tri_verts(localMem.raw(sizeof(uint32_t) * outNT * 3), outMesh);
                                        results[m].pos.assign(vertBuf, vertBuf + outNV * 3);
                                        results[m].idx.assign(triBuf, triBuf + outNT * 3);
                                        results[m].repaired = true;
                                        repairedCount.fetch_add(1);
                                    }
                                }
                                // Sinon (status != NO_ERROR, ou sortie vide) : results[m]
                                // reste au fallback pose plus haut. Attendu, pas une erreur.
                            } catch (...) {
                                // Meme filet que _manifoldRepair cote JS : un corps qui
                                // plante retombe sur son originale, silencieusement.
                                // results[m] deja pose au fallback avant le try.
                            }

                            uint32_t done = repairDone.fetch_add(1) + 1;
                            std::lock_guard<std::mutex> lk(gConsoleMutex);
                            if (done > lastDrawnRepair) {
                                int pct = (int)(100.0 * done / meshCount);
                                int prevPct = (int)(100.0 * lastDrawnRepair / meshCount);
                                if (pct != prevPct || done == meshCount) {
                                    drawBarLine("REPAIR", (double)done / meshCount,
                                        std::to_string(pct) + "%  (" + std::to_string(done) + "/" + std::to_string(meshCount) + ")  R:" + std::to_string(repairedCount.load()));
                                }
                                lastDrawnRepair = done;
                            }
                        }
                    });
                }
                for (auto& th : pool) th.join();

                auto t1 = Clock::now();
                double repairMs = ms(t0, t1);

                std::ostringstream json;
                json << "{\"success\":true,\"meshCount\":" << meshCount
                     << ",\"repairedCount\":" << repairedCount.load() << ",\"counts\":[";
                for (uint32_t m = 0; m < meshCount; m++) {
                    if (m) json << ",";
                    json << (results[m].pos.size() / 3);
                }
                json << "],\"idxCounts\":[";
                for (uint32_t m = 0; m < meshCount; m++) {
                    if (m) json << ",";
                    json << results[m].idx.size();
                }
                json << "],\"repairMs\":" << repairMs << "}";
                std::string js = json.str();
                uint32_t jl = (uint32_t)js.size();

                size_t totalBinBytes = 0;
                for (auto& r : results) totalBinBytes += r.pos.size() * 4 + r.idx.size() * 4;
                std::vector<uint8_t> out(4 + jl + totalBinBytes);
                out[0]=jl&0xFF; out[1]=(jl>>8)&0xFF; out[2]=(jl>>16)&0xFF; out[3]=(jl>>24)&0xFF;
                std::memcpy(out.data()+4, js.data(), jl);
                size_t wOff = 4 + jl;
                for (auto& r : results) {
                    std::memcpy(out.data()+wOff, r.pos.data(), r.pos.size()*4); wOff += r.pos.size()*4;
                    std::memcpy(out.data()+wOff, r.idx.data(), r.idx.size()*4); wOff += r.idx.size()*4;
                }

                std::cerr << cInfo() << "[POST /repair]" << cReset() << " " << meshCount << " mesh(es), " << nThreads << " thread(s) -> "
                          << repairMs << " ms (" << repairedCount.load() << "/" << meshCount
                          << " actually repaired, " << (meshCount - repairedCount.load()) << " unchanged fallback)\n";

                sendResponse(fd, 200, "OK", "application/octet-stream", (const char*)out.data(), out.size());
            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /repair] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (repair)\"}";
                std::cerr << cErr() << "[POST /repair] non-standard ERROR" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        else if (req.method == "POST" && (req.path == "/ifc" || req.path.rfind("/ifc?", 0) == 0)) {
            const double deflection = parseQueryTuning(req.path);
            logStepFileBanner(req.body, "/ifc");
            try {
                double tessMs = 0; int faceCount = 0;
                auto t0 = Clock::now();
                std::vector<uint8_t> nstp = processIfcBuffer(req.body, deflection, tessMs, faceCount);
                auto t1 = Clock::now();
                std::cerr << cInfo() << "[POST /ifc]" << cReset() << " " << (req.body.size()/1024.0) << " KB IFC -> "
                          << nstp.size()/1024.0 << " KB NSTP, " << faceCount << " faces, "
                          << ms(t0,t1) << " ms total\n";
                std::cerr << cInfo() << "[MEM]" << cReset() << " " << memorySummary() << "\n";
                sendResponse(fd, 200, "OK", "application/octet-stream",
                             reinterpret_cast<const char*>(nstp.data()), nstp.size());
            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /ifc] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (OCCT?)\"}";
                std::cerr << cErr() << "[POST /ifc] non-standard exception caught - server still alive" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        // [24/09, soir] GET /stepheld — les etiquettes des imports dont MEDUSA
        // garde le B-Rep exact. Le client s'en sert avant un export : une
        // etiquette absente (MEDUSA redemarre, import sorti du cache navigateur,
        // eviction) se recharge par /stepload, sinon ses corps partiraient en
        // maillage.
        else if (req.method == "GET" && req.path == "/stepheld") {
            std::string j = "{\"tags\":[";
            bool first = true;
            for (const std::string& t : heldImportTags()) { j += (first ? "\"" : ",\"") + jsonEscape(t) + "\""; first = false; }
            j += "]}";
            sendResponse(fd, 200, "OK", "application/json", j.data(), j.size());
        }
        // [24/09, soir] POST /stepload?tag=<empreinte> — relit un STEP pour son
        // B-Rep exact seulement (processStepBuffer, exactOnly) et le garde sous
        // cette etiquette. Aucun maillage n'est calcule ni renvoye : le client a
        // deja le sien, il lui manque seulement le B-Rep cote MEDUSA.
        else if (req.method == "POST" && (req.path == "/stepload" || req.path.rfind("/stepload?", 0) == 0)) {
            const std::string tag = fileTagFromQuery(req.path);
            if (tag.empty()) {
                const char* err = "{\"success\":false,\"error\":\"missing or malformed ?tag= (hex digest of the file)\"}";
                sendResponse(fd, 400, "Bad Request", "application/json", err, strlen(err));
            } else {
                logStepFileBanner(req.body, "/stepload");
                try {
                    double tessMs = 0; int faceCount = 0;
                    const auto t0 = Clock::now();
                    processStepBuffer(req.body, -1.0, tessMs, faceCount, nullptr, tag, true);
                    size_t nParts = 0;
                    {
                        std::lock_guard<std::mutex> lk(gImportMx);
                        for (auto& e : gImports) if (e->tag == tag) nParts = e->parts.size();
                    }
                    const double dt = ms(t0, Clock::now());
                    const std::string j = "{\"success\":true,\"tag\":\"" + tag + "\",\"parts\":" + std::to_string(nParts)
                                        + ",\"ms\":" + std::to_string((long long)dt) + "}";
                    barPhaseStart();
                    char sz[32]; std::snprintf(sz, sizeof sz, "%.1f MB", req.body.size() / 1048576.0);
                    std::cerr << cInfo() << "[POST /stepload]" << cReset() << " " << sz << " STEP -> " << nParts
                              << " exact part(s) held as " << tag << ", " << (long long)dt << " ms (no tessellation)\n";
                    std::cerr << cInfo() << "[MEM]" << cReset() << " " << memorySummary() << "\n";
                    sendResponse(fd, 200, "OK", "application/json", j.data(), j.size());
                } catch (const std::exception& e) {
                    std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                    std::cerr << cErr() << "[POST /stepload] ERROR:" << cReset() << " " << e.what() << "\n";
                    sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
                } catch (...) {
                    const char* err = "{\"success\":false,\"error\":\"non-standard exception (stepload)\"}";
                    std::cerr << cErr() << "[POST /stepload] non-standard exception caught - server still alive" << cReset() << "\n";
                    sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
                }
            }
        }
        else if (req.method == "POST" && (req.path == "/stepexport" || req.path.rfind("/stepexport?", 0) == 0)) {
            // [24/09] Export STEP natif — cf. le bloc stepx:: (protocole NSX1,
            // parallelisme, ecarts assumes avec step-export.js). Reponse :
            // [u32 jsonLen][JSON stats][texte STEP], envoyee en morceaux.
            // Deux temps, comme /stepstream : tout ce qui peut echouer sur une
            // requete mal formee (lecture, plans, #id) se joue AVANT le 200 et
            // repond en JSON d'erreur ; ensuite seulement, en-tetes chunked,
            // frame de stats [u32 jsonLen][JSON], puis le texte STEP au fil
            // de l'eau. Un echec pendant le flux coupe la connexion sans le
            // chunk terminal : le client voit un flux incomplet, jamais un
            // fichier tronque qui aurait l'air entier.
            stepx::Prepared pp;
            bool prepared = false;
            try {
                stepx::prepareExport(req.body, pp, true);
                prepared = true;
            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /stepexport] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (stepexport)\"}";
                std::cerr << cErr() << "[POST /stepexport] non-standard exception caught - server still alive" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
            if (prepared) {
                const std::string head =
                    "HTTP/1.1 200 OK\r\n"
                    + std::string(CORS_HEADERS) +
                    "Content-Type: application/octet-stream\r\n"
                    "Transfer-Encoding: chunked\r\n"
                    "Connection: close\r\n\r\n";
                const stepx::Stats& st = pp.st;
                const std::string js = stepx::statsJson(st, pp.apName);
                std::string frame(4, '\0');
                const uint32_t jl = (uint32_t)js.size();
                frame[0] = (char)(jl & 0xFF); frame[1] = (char)((jl >> 8) & 0xFF);
                frame[2] = (char)((jl >> 16) & 0xFF); frame[3] = (char)((jl >> 24) & 0xFF);
                frame += js;
                bool complete = false;
                try {
                    if (writeAllOk(fd, head.data(), head.size()) && writeChunkOk(fd, frame))
                        complete = stepx::streamExport(pp, [&](const std::string& s) { return writeChunkOk(fd, s); }, true);
                    if (complete) complete = writeAllOk(fd, "0\r\n\r\n", 5);
                } catch (const std::exception& e) {
                    std::cerr << cErr() << "[POST /stepexport] ERROR while streaming:" << cReset() << " " << e.what() << "\n";
                } catch (...) {
                    std::cerr << cErr() << "[POST /stepexport] non-standard exception while streaming - server still alive" << cReset() << "\n";
                }
                barPhaseStart();
                // Tailles en Mo a une decimale : le flux par defaut de cerr ecrivait
                // « 3.70547e+06 KB » pour un export de 3,6 Go.
                auto mb = [](double bytes) { char t[32]; std::snprintf(t, sizeof t, "%.1f MB", bytes / 1048576.0); return std::string(t); };
                if (complete)
                    std::cerr << cInfo() << "[POST /stepexport]" << cReset() << " " << mb((double)req.body.size()) << " mesh -> "
                              << mb((double)st.bytes) << " STEP " << pp.apName << ", " << st.parts << " part(s), "
                              << st.totalTris << " tris, " << st.nManifold << " manifold / " << st.nFaceted << " faceted / "
                              << st.nSphere << " sphere / " << st.nTess << " tessellated / " << st.nExact << " exact ("
                              << st.nProtos << " prototypes)"
                              << (st.nOpen ? " / " + std::to_string(st.nOpen) + " open" : std::string())
                              << ", " << st.entities << " entities - B-Rep " << st.planMs << " ms, ids+assembly " << st.prepMs
                              << " ms, write+send " << st.writeMs << " ms, total " << st.totalMs << " ms ("
                              << st.threads << " threads, " << st.tasks << " blocks)\n";
                if (complete) std::cerr << cInfo() << "[MEM]" << cReset() << " " << memorySummary() << "\n";
                else
                    std::cerr << cWarn() << "[POST /stepexport]" << cReset() << " stream interrupted (client gone or write error) - export abandoned\n";
            }
        }
        else if (req.method == "POST" && (req.path == "/step" || req.path.rfind("/step?", 0) == 0)) {
            // [17/09] ?deflection= / ?k= / ?budget= — cf. parseQueryTuning.
            const double deflection = parseQueryTuning(req.path);
            logStepFileBanner(req.body, "/step");         // [28/08] nom du fichier importe
            // [19/09] IFC et STEP partagent le conteneur ISO 10303-21 : seul le
            // FILE_SCHEMA les distingue. On renifle l en-tete plutot que d exiger
            // du client qu il choisisse le bon endpoint — deposer le fichier suffit.
            const bool looksIfc = req.body.find("FILE_SCHEMA") != std::string::npos
                               && req.body.compare(0, 4096, req.body.substr(0, 4096)) == 0
                               && req.body.substr(0, 4096).find("IFC") != std::string::npos;
            try {
                double tessMs = 0; int faceCount = 0;
                auto t0 = Clock::now();
                std::vector<uint8_t> nstp = looksIfc
                    ? processIfcBuffer(req.body, deflection, tessMs, faceCount)
                    : processStepBuffer(req.body, deflection, tessMs, faceCount, nullptr,
                                        fileTagFromQuery(req.path));   // [24/09, soir] cf. ImportEntry
                auto t1 = Clock::now();
                std::cerr << cInfo() << "[POST /step]" << cReset() << " " << (req.body.size()/1024.0) << " KB STEP -> "
                          << nstp.size()/1024.0 << " KB NSTP, " << faceCount << " faces, "
                          << ms(t0,t1) << " ms total\n";
                std::cerr << cInfo() << "[MEM]" << cReset() << " " << memorySummary() << "\n";
                sendResponse(fd, 200, "OK", "application/octet-stream",
                             reinterpret_cast<const char*>(nstp.data()), nstp.size());
            } catch (const std::exception& e) {
                std::string err = std::string("{\"success\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
                std::cerr << cErr() << "[POST /step] ERROR:" << cReset() << " " << e.what() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err.data(), err.size());
            } catch (...) {
                // Filet ultime : certaines erreurs OCCT remontent des types non derives
                // de std::exception (Standard_Failure selon la config de build) — le
                // serveur loggue et SURVIT, il ne s'eteint jamais sur un fichier hostile.
                const char* err = "{\"success\":false,\"error\":\"non-standard exception (OCCT?)\"}";
                std::cerr << cErr() << "[POST /step] non-standard exception caught - server still alive" << cReset() << "\n";
                sendResponse(fd, 500, "Internal Server Error", "application/json", err, strlen(err));
            }
        }
        else {
            const char* nf = "Not Found";
            sendResponse(fd, 404, "Not Found", "text/plain", nf, strlen(nf));
        }
        nasscadCloseSocket(fd);
    }
#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
