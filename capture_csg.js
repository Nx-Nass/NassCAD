// capture_csg.js — capture le corps binaire des requetes /csg de NASSCAD
// ============================================================================
//
// POURQUOI
// --------
// csg_probe.py a montre que le moteur est exact : 18 cas sur 18, et les ecarts
// collent au facteur polygonal au millieme pres. Le defaut est donc dans les
// operandes que le client envoie.
//
// Et le journal ne suffit pas a savoir lesquels. Il annonce « CSG⚡ 16 segs »
// alors que le volume rapporte implique n≈60, et « 128 segs » sur un cas dont
// le volume DEPASSE l'analytique — ce qu'aucun polygone inscrit ne peut
// produire. La description ne correspond pas aux octets. Il faut donc regarder
// les octets.
//
// Ce script intercepte fetch() et telecharge le corps de chaque requete /csg,
// tel quel, sans rien modifier. Aucune modification de l'application : c'est
// un patch a chaud, il disparait au rechargement de la page.
//
// MODE D'EMPLOI
// -------------
//  1. Dans NASSCAD, ouvre la console : F12, onglet « Console ».
//  2. Colle TOUT ce fichier, Entree. Il repond « armé ».
//     (Firefox peut demander de taper « allow pasting » avant d'accepter.)
//  3. Refais exactement la manipulation qui foire : les 2 cylindres, les Align,
//     puis Subtract.
//  4. Firefox telecharge un .bin par requete. La passe progressive en fait DEUX
//     par operation : csg_capture_01.bin (passe grossiere) et 02 (passe fine).
//     C'est la seconde qui compte — c'est elle qui a produit volume=12410.
//  5. Deplace les .bin a cote de csg_probe.py, puis :
//
//        python csg_probe.py --replay csg_capture_02.bin --dump-obj
//
//     La sonde disseque chaque operande (rayon reel, hauteur reelle, nombre de
//     segments reel, etancheite) et compare le resultat du moteur a ce que
//     cette geometrie impose. Deux issues, toutes deux concluantes :
//       - le moteur rend exactement ce que les operandes imposent
//         -> les operandes sont faux, le bug est dans la retessellation ;
//       - le moteur rend plus de matiere que les operandes n'en laissent
//         -> c'est la booleenne, et le .bin devient le cas de test.
//     Avec --dump-obj tu obtiens aussi les operandes en .obj, a ouvrir dans
//     un viewer pour les voir de tes yeux.
//
// A SURVEILLER dans la sortie de --replay
// ---------------------------------------
//   * la colonne n(ring) : si le solide et les trous n'ont PAS le meme nombre
//     de segments, un trou plus grossier enleve moins de matiere qu'il ne
//     devrait, et le resultat sort trop lourd sans qu'aucune booleenne soit en
//     faute. C'est l'hypothese la plus probable au vu des chiffres.
//   * les colonnes nu / sur : un operande non etanche des l'envoi voudrait dire
//     que le probleme est encore plus en amont, dans la generation des
//     primitives.
//   * les colonnes rayon / y0 / y1 : elles doivent redonner tes saisies —
//     23,5 et 0..20 pour le solide ; 19,5 et 9..20 ; 18 et 0..11.
// ============================================================================

(() => {
  if (window.__csgCaptureArmed) {
    console.log('[capture] deja armé — recharge la page pour repartir de zero.');
    return;
  }
  window.__csgCaptureArmed = true;

  const orig = window.fetch.bind(window);
  let n = 0;
  window.__csgCaptures = [];

  // Ramene n'importe quelle forme de corps a un ArrayBuffer, sans consommer
  // l'original : la requete doit partir intacte.
  const toBuffer = async (body) => {
    if (!body) return null;
    if (body instanceof ArrayBuffer) return body.slice(0);
    if (ArrayBuffer.isView(body)) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.arrayBuffer();
    return null;
  };

  const save = (buf, label) => {
    n++;
    const name = `csg_capture_${String(n).padStart(2, '0')}.bin`;
    window.__csgCaptures.push({ name, bytes: buf.byteLength, buf });
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    } catch (e) {
      console.warn('[capture] telechargement refuse :', e.message,
                   '— le corps reste dans window.__csgCaptures');
    }
    // En-tete du protocole : [u32 opType][u32 nOperands][u32 solidsCount]
    let head = '';
    if (buf.byteLength >= 12) {
      const dv = new DataView(buf);
      const op = dv.getUint32(0, true), cnt = dv.getUint32(4, true), sol = dv.getUint32(8, true);
      head = ` — op=${['union', 'subtract', 'intersect'][op] ?? op}`
           + ` operandes=${cnt} cible=${sol}`;
    }
    console.log(`[capture] ${name} ${label} : ${buf.byteLength} octets${head}`);
  };

  window.fetch = async function (input, init) {
    let url = '';
    try {
      url = (typeof input === 'string') ? input
          : (input && typeof input.url === 'string') ? input.url : String(input);
    } catch (e) { url = ''; }

    if (/\/csg(tree)?(\?|$)/.test(url)) {
      const label = /csgtree/.test(url) ? '(csgtree)' : '(csg)';
      try {
        if (init && init.body) {
          const buf = await toBuffer(init.body);
          if (buf) save(buf, label);
          else console.warn('[capture] corps de type inattendu :', init.body && init.body.constructor
                            && init.body.constructor.name);
        } else if (input && typeof input.clone === 'function') {
          // Requete envoyee sous forme d'objet Request : on clone pour lire
          // sans consommer le flux d'origine.
          const buf = await input.clone().arrayBuffer();
          if (buf && buf.byteLength) save(buf, label + ' [Request]');
        }
      } catch (e) {
        console.warn('[capture] echec de capture (la requete part quand meme) :', e.message);
      }
    }
    return orig(input, init);
  };

  console.log('%c[capture] armé.', 'font-weight:bold');
  console.log('Refais ta manipulation (2 cylindres, Align, Subtract).');
  console.log('Un .bin sera telecharge par requete /csg — la passe progressive en fait deux,');
  console.log('garde la SECONDE. Puis : python csg_probe.py --replay csg_capture_02.bin --dump-obj');
  console.log('Les corps restent aussi accessibles dans window.__csgCaptures si le');
  console.log('telechargement automatique est bloque.');
})();
