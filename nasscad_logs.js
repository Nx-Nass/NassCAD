// ══════════════════════════════════════════════════════════════
// ██  NASSCAD — LOG ENGINE  v4.2.5
// ██  Fichier séparé — chargé via <script src="nasscad_logs.js">
// ██  Dépendances globales attendues dans le HTML principal :
// ██    idbLogSave(entry)          — écriture IDB
// ██    idbUpdateQuotaDisplay()    — jauge IDB
// ██    idbTx(store, mode)         — transaction IDB
// ██    _idbReady                  — flag IDB prêt
// ══════════════════════════════════════════════════════════════

'use strict';

// ── Constantes ────────────────────────────────────────────────
const LOG_MAX = 2000;       // Entrées max en RAM
const LOG_IDB_MAX = 2000;   // Entrées max dans log_history IDB

// ── État ──────────────────────────────────────────────────────
let _logEntries = [];        // Historique session courante
let _logFilter  = 'ALL';     // Filtre actif
let _logVisible = false;     // Fenêtre ouverte ?
// Instantané du journal du MOTEUR (MEDUSA), rapporté à la demande. Stocké à part
// de _logEntries EXPRÈS : un journal moteur fait couramment plusieurs milliers de
// lignes, et LOG_MAX vaut 2000 — l'injecter dans l'historique client chasserait
// tout le reste. Ici il ne concurrence rien, il n'est ni tronqué ni persisté.
let _medusaSnap = null;      // { source, when, lines[], total }
const MEDUSA_SNAP_RENDER = 3000;   // lignes affichées au maximum (l'export garde tout)

// ── Patch console — capture console.log/warn/error → nasLog ──
(function(){
  const _orig = { log: console.log, warn: console.warn, error: console.error };
  console.log   = function(...a){ _orig.log(...a);   nasLog('INFO',  a.map(String).join(' ')); };
  console.warn  = function(...a){ _orig.warn(...a);  nasLog('WARN',  a.map(String).join(' ')); };
  console.error = function(...a){ _orig.error(...a); nasLog('ERROR', a.map(String).join(' ')); };
  window.addEventListener('error', ev =>
    nasLog('ERROR', ev.message + (ev.filename ? ' @ ' + ev.filename + ':' + ev.lineno : '')));
  window.addEventListener('unhandledrejection', ev =>
    nasLog('ERROR', 'Promise rejet: ' + (ev.reason?.message || ev.reason)));
})();

// ── nasLog(level, msg) — point d'entrée unique ─────────────────
// Niveaux : ERROR · WARN · OK · INFO · CSG · IDB · MEDUSA · DBG
// DBG n'est pas sauvegardé en IDB (trop verbeux)
function nasLog(level, msg){
  const ts = new Date().toLocaleTimeString('en-US',{
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const entry = { ts, level, msg };
  _logEntries.push(entry);
  if(_logEntries.length > LOG_MAX) _logEntries.shift();
  if(_logVisible) _logAppendDOM(entry);
  // Sauvegarde IDB — DBG exclu volontairement
  if(typeof idbLogSave === 'function' &&
     ['ERROR','WARN','OK','INFO','CSG','IDB','MEDUSA'].includes(level)){
    idbLogSave(entry);
  }
}

// ── Correspondance entrée / filtre ─────────────────────────────
// MEDUSA est le seul filtre TRANSVERSAL : il retient les entrées de niveau
// MEDUSA, mais aussi toutes celles qui parlent du moteur sous un autre niveau
// (les 'OK Machine facts via MEDUSA', 'WARN MEDUSA unreachable', 'CSG ✓ … native
// MEDUSA' déjà en place). Ça évite de réétiqueter une quinzaine d'appels
// existants — et de déplacer ces lignes hors des filtres où tu les cherches
// aujourd'hui. Un filtre qui rassemble, pas qui déménage.
function _logMatch(e){
  if(_logFilter === 'ALL') return true;
  if(_logFilter === 'MEDUSA') return e.level === 'MEDUSA' || /MEDUSA/i.test(e.msg);
  return _logFilter === e.level;
}

// ── Rendu DOM d'une entrée ─────────────────────────────────────
function _logAppendDOM(e){
  if(!_logMatch(e)) return;
  const body = document.getElementById('log-body');
  if(!body) return;
  const div = document.createElement('div');
  div.className = 'log-entry log-' + e.level;
  div.innerHTML =
    `<span class="log-ts">${e.ts}</span>` +
    `<span class="log-lvl">[${e.level}]</span>` +
    `<span class="log-msg">${_escHtml(e.msg)}</span>`;
  body.appendChild(div);
  const cb = document.getElementById('log-autoscroll');
  if(cb && cb.checked) body.scrollTop = body.scrollHeight;
  const el = document.getElementById('log-count');
  if(el) el.textContent = _logEntries.length + ' entries';
}

// ── Échappement HTML ───────────────────────────────────────────
function _escHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Rebuild complet de la liste ────────────────────────────────
function _logRebuild(){
  const body = document.getElementById('log-body');
  if(!body) return;
  body.innerHTML = '';
  _logEntries.forEach(e => {
    if(_logMatch(e)){
      const div = document.createElement('div');
      div.className = 'log-entry log-' + e.level;
      div.innerHTML =
        `<span class="log-ts">${e.ts}</span>` +
        `<span class="log-lvl">[${e.level}]</span>` +
        `<span class="log-msg">${_escHtml(e.msg)}</span>`;
      body.appendChild(div);
    }
  });
  // Instantané moteur — après les entrées client, jamais mélangé : c'est un
  // relevé pris à un instant T, pas un flux chronologique du même horloge.
  if(_logFilter === 'MEDUSA' && _medusaSnap) _medusaSnapRender(body);
  body.scrollTop = body.scrollHeight;
  const el = document.getElementById('log-count');
  if(el) el.textContent = _logEntries.length + ' entries'
    + (_medusaSnap ? ' + ' + _medusaSnap.total + ' engine' : '');
}

// Rendu du bloc moteur. Les lignes portent déjà leur propre horodatage : on ne
// leur en recolle pas un second, et on ne réserve pas la colonne de niveau.
function _medusaSnapRender(body){
  const s = _medusaSnap;
  const head = document.createElement('div');
  head.className = 'log-entry log-MEDUSA';
  head.innerHTML = `<span class="log-msg"><b>── engine log · ${_escHtml(s.source)} · ${s.when}`
    + ` · ${s.lines.length}/${s.total} line(s) ──</b></span>`;
  body.appendChild(head);
  for(const l of s.lines){
    const d = document.createElement('div');
    d.className = 'log-entry log-MEDUSA log-eng';
    d.innerHTML = `<span class="log-msg">${_escHtml(l)}</span>`;
    body.appendChild(d);
  }
  const foot = document.createElement('div');
  foot.className = 'log-entry log-MEDUSA';
  foot.innerHTML = '<span class="log-msg"><b>── end of engine log ──</b></span>';
  body.appendChild(foot);
}

// ── Filtre ────────────────────────────────────────────────────
function setLogFilter(f){
  _logFilter = f;
  document.querySelectorAll('.log-fbtn')
    .forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  _logRebuild();
}

// ── Ouvrir / fermer la fenêtre log ────────────────────────────
function toggleLogWin(){
  _logVisible = !_logVisible;
  const w = document.getElementById('log-win');
  w.style.display = _logVisible ? 'flex' : 'none';
  if(_logVisible){
    _logRebuild();
    if(typeof idbUpdateQuotaDisplay === 'function') idbUpdateQuotaDisplay();
  }
}

// ══════════════════════════════════════════════════════════════
// ██  JOURNAL DU MOTEUR MEDUSA — à la demande
// ══════════════════════════════════════════════════════════════
// Deux sources, essayées dans cet ordre :
//
//   1) GET /log sur le moteur — la voie normale depuis la version du 04/09.
//      Le moteur n'écrit plus de fichier par défaut : il garde ses 20 000
//      dernières lignes en mémoire et les sert ici, en text/plain, une ligne
//      par ligne, la plus récente en dernier, ?n=<max> pour borner.
//      [05/09] Ce commentaire a dit le contraire pendant un temps ("le binaire
//      3.1 ne sert PAS cet endpoint") : c'était vrai le jour où le bouton a été
//      écrit, en avance sur le C++, et faux depuis que le C++ a suivi.
//
//   2) Sélecteur de fichier — repli, pour un moteur éteint, un binaire
//      antérieur, ou une session lancée avec --logfile dont on veut relire le
//      medusa-logs-<horodatage>.txt. En file://, aucune API ne permet de lire
//      ce fichier sans que l'utilisateur le désigne : même repli que celui du
//      kernel OCCT dans quick-fillet.js.
//
// Dans les deux cas le résultat atterrit au même endroit, sous le filtre MEDUSA,
// à côté de ce que NASSCAD sait déjà du moteur — les deux journaux d'une même
// session enfin lisibles en parallèle.
async function medusaLogPull(nMax){
  const N = nMax || 4000;
  const url = (typeof _BOOSTER_URL !== 'undefined')
    ? _BOOSTER_URL : 'http://127.0.0.1:8765';
  try{
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${url}/log?n=${N}`, { signal: ctrl.signal });
    clearTimeout(t);
    if(res.ok){
      _medusaLogIngest(await res.text(), 'engine GET /log');
      return;
    }
  }catch(e){ /* moteur éteint, ou binaire antérieur au /log : le sélecteur prend le relais */ }
  // Le message ne peut pas trancher entre "moteur éteint" et "binaire trop
  // ancien" : le fetch échoue pareil dans les deux cas. Il dit donc les deux,
  // plutôt que d'accuser à tort le binaire comme il le faisait avant.
  nasLog('MEDUSA','No answer on GET /log — engine stopped, or a build older than the /log endpoint. Pick a medusa-logs-*.txt file instead (the engine only writes one when started with --logfile).');
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.txt,.log,text/plain';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if(!f) return;
    const rd = new FileReader();
    rd.onload  = () => _medusaLogIngest(String(rd.result), f.name);
    rd.onerror = () => nasLog('ERROR','MEDUSA log: cannot read ' + f.name);
    rd.readAsText(f);
  };
  inp.oncancel = () => nasLog('MEDUSA','Engine log: selection cancelled');
  inp.click();
}

function _medusaLogIngest(text, source){
  const all = String(text).replace(/\r/g,'').split('\n');
  while(all.length && !all[all.length-1].trim()) all.pop();   // queue vide
  if(!all.length){ nasLog('WARN','MEDUSA log: ' + source + ' is empty'); return; }
  _medusaSnap = {
    source,
    when : new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}),
    lines: all.length > MEDUSA_SNAP_RENDER ? all.slice(-MEDUSA_SNAP_RENDER) : all,
    total: all.length,
    text                                   // intégral, pour l'export
  };
  nasLog('MEDUSA', `Engine log loaded — ${all.length} line(s) from ${source}`);
  setLogFilter('MEDUSA');                  // rebuild + bascule sur le filtre
}

// ── Vider ─────────────────────────────────────────────────────
function logClear(){
  _logEntries = [];
  const body = document.getElementById('log-body');
  if(body) body.innerHTML = '';
  const el = document.getElementById('log-count');
  if(el) el.textContent = '0 entries';
  nasLog('INFO', 'Console cleared.');
}

// ── Formatage de date lisible pour noms de fichiers exportés ──
// Format exact demandé : nasscad-logs-YYYY-MM-DD_HH-mm-ss.txt (heure locale,
// cohérent avec nasLog() qui affiche déjà l'heure locale, pas UTC).
function _fmtLogFilename(){
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ── Export .txt ───────────────────────────────────────────────
function logExport(){
  let lines = _logEntries
    .map(e => `[${e.ts}][${e.level}] ${e.msg}`)
    .join('\n');
  // Le journal moteur part avec, INTÉGRAL (pas la troncature d'affichage) :
  // un rapport d'incident où les deux côtés manquent l'un à l'autre ne sert à rien.
  if(_medusaSnap){
    lines += `\n\n════ MEDUSA engine log · ${_medusaSnap.source} · pulled at ${_medusaSnap.when}`
           + ` · ${_medusaSnap.total} line(s) ════\n` + _medusaSnap.text;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines], {type:'text/plain'}));
  a.download = 'nasscad-logs-' + _fmtLogFilename() + '.txt';
  a.click();
  nasLog('OK', 'Logs exported (' + _logEntries.length + ' entries'
    + (_medusaSnap ? ' + ' + _medusaSnap.total + ' engine lines' : '') + ').');
}

// ── Copie presse-papier ─────────────────────────────────────────
// Même format de ligne que logExport(). API Clipboard moderne d'abord,
// repli textarea+execCommand ensuite (nécessaire en file://, où
// navigator.clipboard peut être refusé selon le navigateur).
async function logCopyClipboard(){
  const lines = _logEntries
    .map(e => `[${e.ts}][${e.level}] ${e.msg}`)
    .join('\n');
  let copied = false;
  try{
    await navigator.clipboard.writeText(lines);
    copied = true;
  }catch(e){
    try{
      const ta = document.createElement('textarea');
      ta.value = lines;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      copied = document.execCommand('copy');
      ta.remove();
    }catch(e2){ copied = false; }
  }
  if(copied){
    nasLog('OK', 'Logs copied to clipboard (' + _logEntries.length + ' entries).');
  }else{
    nasLog('ERROR', 'logCopyClipboard: copie échouée (permissions navigateur ?)');
  }
}

// ══════════════════════════════════════════════════════════════
// ██  RAPPEL IDB — Recharge les logs de sessions précédentes
// ══════════════════════════════════════════════════════════════
// Lit le store log_history dans IndexedDB et injecte les entrées
// en tête de _logEntries (avant les logs de la session courante).
// Un marqueur visuel "── session précédente ──" sépare les deux.
// Bouton "📂 Rappel IDB" dans le panneau log.

async function logRecallIDB(maxEntries){
  const n = maxEntries || 200;
  if(typeof _idbReady === 'undefined' || !_idbReady){
    nasLog('WARN','logRecallIDB: IDB non prêt');
    return;
  }
  try{
    const entries = await new Promise((resolve, reject) => {
      const results = [];
      const req = idbTx('log_history','readonly').openCursor(null,'prev');
      req.onsuccess = ev => {
        const cur = ev.target.result;
        if(cur && results.length < n){
          results.push({ ts: cur.value.ts, level: cur.value.level, msg: cur.value.msg });
          cur.continue();
        } else {
          resolve(results.reverse()); // Remettre dans l'ordre chronologique
        }
      };
      req.onerror = e => reject(e.target.error);
    });

    if(!entries.length){
      nasLog('INFO','logRecallIDB: aucune entrée en IDB');
      return;
    }

    // Injecter un séparateur + les entrées IDB en tête de la session
    const separator = {
      ts: '──────',
      level: 'INFO',
      msg: `── ${entries.length} entrées rappelées depuis IDB (sessions précédentes) ──`
    };
    _logEntries = [separator, ...entries, ..._logEntries];
    if(_logEntries.length > LOG_MAX * 2) _logEntries = _logEntries.slice(-LOG_MAX * 2);

    if(_logVisible) _logRebuild();
    nasLog('OK', `logRecallIDB: ${entries.length} entrées chargées depuis IDB`);
  } catch(err){
    nasLog('ERROR','logRecallIDB: ' + err.message);
  }
}