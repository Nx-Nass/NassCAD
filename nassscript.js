// ══════════════════════════════════════════════════════════════════════════
// nassscript.js — module NassScript (console JS intégrée) extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer cet identifiant dans le host sans relancer le scan.
//
//   nasLog — app-wide logging helper
//
//   Note : NassScript fonctionne par eval() sur le scope global à l'exécution
//   (accès à TOUTES les fonctions globales NASSCAD par design). Cette liste
//   de dépendances statique ne couvre que le code de l'infra NassScript
//   elle-même (historique, stringify sûr, flux de logs,
//   stop coopératif) — pas le code que l'utilisateur tape et exécute.
// ══════════════════════════════════════════════════════════════════════════
// ── NassScript — Console JS intégrée ─────────────────────────────────────
// Accès complet à toutes les fonctions globales NASSCAD via eval()
// Usage : coller un script dans le modal ⚡ Script → Run
// ──────────────────────────────────────────────────────────────────────────

// ── NassScript — accès (verrou mot de passe retiré le 12/09) ──────────────
// Le prompt de mot de passe a été supprimé : en 100% client-side (zéro
// serveur, c'est toute l'archi NASSCAD) il ne filtrait que le clic casual,
// et n'importe qui pouvait le contourner via les devtools dans ce même scope
// global. L'avertissement UI « ⚠ Dev tool / full JS scope » du modal reste la
// bonne barrière : elle informe sans prétendre protéger.
//
// À GARDER EN TÊTE : le jour où une vraie clé d'API IA passe par ce point
// d'entrée, elle ne doit JAMAIS être codée en dur ici — il faudra un proxy
// serveur qui la garde côté back, sinon n'importe qui la récupère et
// consomme ton quota. Un verrou client-side n'y aurait rien changé.

function showScriptEditor(){
  const el = document.getElementById('script-modal');
  el.style.left = Math.max(0, (innerWidth  - 560) / 2) + 'px';
  el.style.top  = Math.max(28,(innerHeight - 460) / 2) + 'px';
  el.classList.add('open');
  document.getElementById('script-code').focus();
}

function hideScriptEditor(){
  document.getElementById('script-modal').classList.remove('open');
}

function clearScriptEditor(){
  document.getElementById('script-code').value = '';
  _scriptLogBuf = [];
  document.getElementById('script-output').textContent = '';
}

// ── NassScript — historique des 20 dernières exécutions (sessionStorage + cache RAM)
// M2 FIX : _scriptHistCache évite JSON.parse/stringify à chaque frappe Ctrl+↑/↓
const _SCRIPT_HIST_KEY='nasscad_script_hist';
let _scriptHistIdx=-1;
let _scriptHistCache=null; // cache RAM — invalidé par _scriptHistPush
function _scriptHistLoad(){
  if(_scriptHistCache!==null)return _scriptHistCache;
  try{_scriptHistCache=JSON.parse(sessionStorage.getItem(_SCRIPT_HIST_KEY)||'[]');}catch(e){_scriptHistCache=[];}
  return _scriptHistCache;
}
function _scriptHistPush(code){
  const h=_scriptHistLoad();
  if(h[0]!==code)h.unshift(code);
  if(h.length>20)h.length=20;
  _scriptHistCache=h; // cache mis à jour
  try{sessionStorage.setItem(_SCRIPT_HIST_KEY,JSON.stringify(h));}catch(e){}
  _scriptHistIdx=-1;
}
function _scriptHistNav(dir){
  const h=_scriptHistLoad();
  if(!h.length)return null;
  if(dir>0)_scriptHistIdx=Math.min(h.length-1,_scriptHistIdx+1);
  else _scriptHistIdx=Math.max(-1,_scriptHistIdx-1);
  return _scriptHistIdx<0?'':h[_scriptHistIdx];
}

// ── NassScript — stringify sûr : évite le crash JSON.stringify sur refs
// circulaires (ex: un mesh Three.js retourné tel quel — .parent ↔ .children
// font planter JSON.stringify natif, ce qui affichait un faux "✗ error" alors
// que le script avait très bien tourné — seul l'affichage choquait).
function _scriptSafeStringify(v){
  try{ return JSON.stringify(v); }
  catch(e){
    try{
      const seen=new WeakSet();
      return JSON.stringify(v,(k,val)=>{
        if(val&&typeof val==='object'){
          if(seen.has(val))return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    }catch(e2){ return String(v); }
  }
}

// ── NassScript — flux de logs : accumule des lignes PENDANT l'exécution
// (au lieu d'attendre uniquement la valeur de retour finale) + rendu dans
// #script-output avec auto-scroll. Accessible depuis le code du script :
// scriptLog('étape 1', someObj, 42) — args non-string passés par
// _scriptSafeStringify.
let _scriptLogBuf=[];
function _scriptRenderOutput(){
  const out=document.getElementById('script-output');
  out.textContent=_scriptLogBuf.join('\n');
  out.scrollTop=out.scrollHeight;
}
function scriptLog(...args){
  const line=args.map(a=>typeof a==='string'?a:_scriptSafeStringify(a)).join(' ');
  _scriptLogBuf.push(line);
  _scriptRenderOutput();
}

// ── NassScript — stop coopératif : aucune interruption dure n'est possible
// sur du JS synchrone (le main thread ne cède la main qu'aux points d'await),
// donc pas de vrai kill-switch sans faire tourner ça dans un Worker (ce qui
// casserait l'accès direct synchrone à la scène/DOM qui fait l'intérêt de la
// feature). On expose un flag + un helper à appeler explicitement dans les
// boucles du script : for(...){ scriptCheckStop(); await doCSG('union'); }
let _scriptStopRequested=false;
function scriptCheckStop(){
  if(_scriptStopRequested) throw new Error('⏹ Stopped by user');
}
function stopScript(){
  _scriptStopRequested=true;
  scriptLog('⏹ Stop requested — the script will stop at the next scriptCheckStop() encountered');
}

async function runScript(){
  const code = document.getElementById('script-code').value.trim();
  const out  = document.getElementById('script-output');
  if(!code){ out.textContent = '— no code —'; return; }
  _scriptHistPush(code); // historique
  _scriptLogBuf=[];
  _scriptStopRequested=false;
  const stopBtn=document.getElementById('script-stop-btn');
  stopBtn.disabled=false;
  out.style.color = 'var(--muted)';
  scriptLog('▶ Running…');
  nasLog('OK','NassScript ▶ '+code.split('\n')[0].substring(0,60)+(code.split('\n').length>1?'…':''));
  try {
    // AsyncFunction pour supporter await (doCSG est async)
    const fn = new Function('return (async()=>{\n'+code+'\n})()');
    const result = await fn();
    out.style.color = 'var(--success)';
    scriptLog(result !== undefined ? '→ '+_scriptSafeStringify(result) : '✓ OK');
    nasLog('OK','NassScript ✓ done');
  } catch(e){
    out.style.color = 'var(--danger)';
    scriptLog('✗ '+e.message);
    nasLog('ERROR','NassScript: '+e.message);
  } finally {
    stopBtn.disabled=true;
  }
}

// ── Fin NassScript ────────────────────────────────────────────────────────
