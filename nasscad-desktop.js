(() => {
  const api = window.electronAPI;
  if (!api?.isElectron) return;
  const style = document.createElement('style');
  style.textContent = `
#desktop-medusa-button{position:fixed;left:12px;bottom:30px;z-index:9000;padding:5px 10px;border:1px solid var(--border,#455268);border-radius:6px;background:var(--panel,#192230);color:#8ee8a8;font:12px system-ui;cursor:pointer}
#desktop-medusa{box-sizing:border-box;position:fixed;z-index:9001;min-width:420px;min-height:200px;max-width:calc(100vw - 180px);max-height:calc(100vh - 92px);border:1px solid #455268;border-radius:8px;background:#0c0c0c;color:#ccc;box-shadow:0 8px 30px #0008;font:12px system-ui;display:flex;flex-direction:column;overflow:hidden;resize:both}
#desktop-medusa[hidden]{display:none}#desktop-medusa[data-maximized=true]{resize:none}
#desktop-medusa header{display:flex;gap:8px;align-items:center;padding:10px;background:#192230;border-bottom:1px solid #455268;cursor:move;user-select:none;touch-action:none}
#desktop-medusa-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e0e8f1}
#desktop-medusa pre{white-space:pre-wrap;overflow:auto;flex:1;min-height:0;margin:0;padding:12px;font:var(--medusa-font-size,13px)/1.35 Consolas,monospace;user-select:text;tab-size:4}
#desktop-medusa button{cursor:pointer;background:#29384a;color:#e0e8f1;border:1px solid #53627a;border-radius:4px;padding:4px 8px;font:12px system-ui}
#desktop-medusa button:disabled{opacity:.6;cursor:wait}#desktop-medusa footer{display:flex;align-items:center;gap:8px;padding:5px 16px 5px 10px;border-top:1px solid #455268;background:#192230;color:#b9c7d7}#desktop-medusa-updated{flex:1}
`;
  document.head.append(style);
  const button = document.createElement('button');
  button.id = 'desktop-medusa-button'; button.textContent = '● MEDUSA';
  button.title = 'Integrated engine status and log'; button.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.id = 'desktop-medusa'; panel.hidden = true; panel.setAttribute('aria-label', 'Integrated Medusa engine');
  const header = document.createElement('header');
  const status = document.createElement('span'); status.id = 'desktop-medusa-status';
  const makeButton = (text, title) => { const b = document.createElement('button'); b.textContent = text; b.title = title; b.setAttribute('aria-label', title); return b; };
  const refresh = makeButton('Refresh', 'Refresh the Medusa log');
  const maximize = makeButton('Maximize', 'Maximize the Medusa window');
  const close = makeButton('Close', 'Close the Medusa window');
  const log = document.createElement('pre'); log.setAttribute('aria-label', 'Medusa console output');
  const footer = document.createElement('footer');
  const updated = document.createElement('span'); updated.id = 'desktop-medusa-updated'; updated.textContent = 'Live log';
  const smaller = makeButton('A−', 'Decrease console font size'), larger = makeButton('A+', 'Increase console font size');
  header.append(status, refresh, maximize, close); footer.append(updated, smaller, larger); panel.append(header, log, footer); document.body.append(button, panel);
  const storageKey = 'nasscad.medusa.window.v1';
  let normalBounds, fontSize = 13, maximized = false, lastLog, saveTimer, refreshing = false, pendingForce = false;
  const bounds = () => { const r = panel.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
  function applyBounds(value) {
    const width = Math.min(Math.max(420,value.width),innerWidth-180), height = Math.min(Math.max(200,value.height),innerHeight-92);
    const x = Math.max(12,Math.min(value.x,innerWidth-width-168)), y = Math.max(48,Math.min(value.y,innerHeight-height-44));
    Object.assign(panel.style,{left:x+'px',top:y+'px',width:width+'px',height:height+'px'});
  }
  function save() {
    if (!panel.hidden && !maximized) normalBounds = bounds();
    try { localStorage.setItem(storageKey,JSON.stringify({bounds:normalBounds,fontSize})); } catch {}
  }
  try { const saved=JSON.parse(localStorage.getItem(storageKey)); if(saved?.bounds && Object.values(saved.bounds).every(Number.isFinite)) normalBounds=saved.bounds; if(Number.isFinite(saved?.fontSize))fontSize=Math.max(10,Math.min(24,saved.fontSize)); } catch {}
  normalBounds ||= {x:12,y:innerHeight-445,width:Math.min(760,innerWidth-180),height:380};
  applyBounds(normalBounds); panel.style.setProperty('--medusa-font-size',fontSize+'px');
  function toggleMaximize() {
    if(!maximized)normalBounds=bounds(); maximized=!maximized; panel.dataset.maximized=String(maximized);
    applyBounds(maximized?{x:12,y:48,width:innerWidth-180,height:innerHeight-92}:normalBounds);
    maximize.textContent=maximized?'Restore':'Maximize'; maximize.title=maximized?'Restore the Medusa window':'Maximize the Medusa window'; maximize.setAttribute('aria-label',maximize.title); save();
  }
  maximize.onclick=toggleMaximize;
  header.ondblclick=event=>{if(!event.target.closest('button'))toggleMaximize()};
  let drag;
  header.onpointerdown=event=>{if(event.button!==0 || maximized || event.target.closest('button'))return;const r=bounds();drag={id:event.pointerId,x:event.clientX,y:event.clientY,bounds:r};header.setPointerCapture(event.pointerId);event.preventDefault()};
  header.onpointermove=event=>{if(!drag)return;applyBounds({...drag.bounds,x:drag.bounds.x+event.clientX-drag.x,y:drag.bounds.y+event.clientY-drag.y})};
  header.onpointerup=header.onpointercancel=event=>{if(!drag)return;drag=null;if(header.hasPointerCapture(event.pointerId))header.releasePointerCapture(event.pointerId);save()};
  new ResizeObserver(()=>{if(!panel.hidden&&!maximized)applyBounds(bounds());clearTimeout(saveTimer);saveTimer=setTimeout(save,250)}).observe(panel);
  window.addEventListener('resize',()=>{if(!panel.hidden)applyBounds(maximized?{x:12,y:48,width:innerWidth-180,height:innerHeight-92}:bounds())});
  function changeFont(delta){fontSize=Math.max(10,Math.min(24,fontSize+delta));panel.style.setProperty('--medusa-font-size',fontSize+'px');save()}
  smaller.onclick=()=>changeFont(-1);larger.onclick=()=>changeFont(1);
  // Render only text nodes: imported model names cannot become HTML.
  function renderConsole(text) {
    const palette=['#0c0c0c','#c50f1f','#13a10e','#c19c00','#0037da','#881798','#3a96dd','#ccc','#767676','#e74856','#16c60c','#f9f1a5','#3b78ff','#b4009e','#61d6d6','#f2f2f2'];
    const fragment=document.createDocumentFragment();let color='',bold=false,offset=0;const sgr=/\x1b\[([0-9;]*)m/g;let match;
    const append=value=>{if(!value)return;const span=document.createElement('span');span.textContent=value;if(color)span.style.color=color;if(bold)span.style.fontWeight='700';fragment.append(span)};
    while((match=sgr.exec(text))){append(text.slice(offset,match.index));offset=sgr.lastIndex;for(const n of match[1].split(';').map(v=>Number(v||0))){if(n===0){color='';bold=false}else if(n===1)bold=true;else if(n===22)bold=false;else if(n===39)color='';else if(n>=30&&n<=37)color=palette[n-30];else if(n>=90&&n<=97)color=palette[n-90+8]}}
    append(text.slice(offset));log.replaceChildren(fragment);
  }
  async function update(force=false) {
    if(refreshing){pendingForce ||= force;return}refreshing=true;
    if(force){refresh.disabled=true;refresh.textContent='Refreshing…';updated.textContent='Refreshing log…'}
    try {
      const state=await api.medusaStatus();
      button.textContent=state.running?'● MEDUSA · running':'● MEDUSA · stopped';button.style.color=state.running?'#16c60c':'#e74856';
      status.textContent=state.running?'MEDUSA · internal pipe · PID '+state.pid:'MEDUSA · '+state.error;status.title=status.textContent;
      if(!panel.hidden){const nearEnd=log.scrollHeight-log.scrollTop-log.clientHeight<60;const text=await api.medusaLog(force);if(text!==lastLog){renderConsole(text);lastLog=text}if(nearEnd||force)log.scrollTop=log.scrollHeight;if(force)updated.textContent='Refreshed '+new Date().toLocaleTimeString('en-GB')}
    } catch(error){updated.textContent='Refresh failed: '+error.message}
    finally{refreshing=false;refresh.disabled=false;refresh.textContent='Refresh';if(pendingForce){pendingForce=false;update(true)}}
  }
  button.onclick=()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){applyBounds(maximized?{x:12,y:48,width:innerWidth-180,height:innerHeight-92}:normalBounds);update()}};
  close.onclick=()=>{save();panel.hidden=true;button.setAttribute('aria-expanded','false')};refresh.onclick=()=>update(true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)close.click()});
  update();setInterval(()=>update(),3000);
})();
