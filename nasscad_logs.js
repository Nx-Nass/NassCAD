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
// Niveaux : ERROR · WARN · OK · INFO · CSG · IDB · DBG
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
     ['ERROR','WARN','OK','INFO','CSG','IDB'].includes(level)){
    idbLogSave(entry);
  }
}

// ── Rendu DOM d'une entrée ─────────────────────────────────────
function _logAppendDOM(e){
  if(_logFilter !== 'ALL' && _logFilter !== e.level) return;
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
    if(_logFilter === 'ALL' || _logFilter === e.level){
      const div = document.createElement('div');
      div.className = 'log-entry log-' + e.level;
      div.innerHTML =
        `<span class="log-ts">${e.ts}</span>` +
        `<span class="log-lvl">[${e.level}]</span>` +
        `<span class="log-msg">${_escHtml(e.msg)}</span>`;
      body.appendChild(div);
    }
  });
  body.scrollTop = body.scrollHeight;
  const el = document.getElementById('log-count');
  if(el) el.textContent = _logEntries.length + ' entries';
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
  const lines = _logEntries
    .map(e => `[${e.ts}][${e.level}] ${e.msg}`)
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines], {type:'text/plain'}));
  a.download = 'nasscad-logs-' + _fmtLogFilename() + '.txt';
  a.click();
  nasLog('OK', 'Logs exported (' + _logEntries.length + ' entries).');
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
