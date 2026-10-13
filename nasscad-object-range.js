/* Objects panel: contiguous selection in visible display order. */
(()=>{'use strict';
const panel=document.getElementById('olist-c');if(!panel)return;
panel.tabIndex=0;panel.setAttribute('aria-label','Objects — Shift click or Shift Up/Down selects a range');
let anchor=null,cursor=null,base=[],ranging=false;
const order=()=>Array.from(panel.querySelectorAll('.oi[data-id]')).map(row=>_idMap.get(Number(row.dataset.id))).filter(Boolean);
function focusRow(id){panel.focus({preventScroll:true});const row=panel.querySelector(`.oi[data-id="${id}"]`);if(row)row.scrollIntoView({block:'nearest'});}
function publish(){hideAlignDots();updProps();updOList(true);updCSG();if(alignMode)updateAlignDots();}
function range(list,target,add){
 let start=list.findIndex(o=>o.id===anchor);
 if(start<0){const selected=list.find(o=>selObjs.includes(o));anchor=(selected||target).id;start=list.findIndex(o=>o.id===anchor);}
 if(!ranging){base=add?selObjs.slice():[];ranging=true;}
 const end=list.indexOf(target),span=list.slice(Math.min(start,end),Math.max(start,end)+1);
 selObjs=Array.from(new Set([...base,...span]));cursor=target.id;publish();focusRow(cursor);
}
hOC=function(e,id){
 const o=_idMap.get(id);if(!o)return;
 const list=order();if(!list.includes(o))return;
 if(e.shiftKey){range(list,o,e.ctrlKey||e.metaKey);return;}
 ranging=false;base=[];anchor=cursor=id;selObj(o,e.ctrlKey||e.metaKey);focusRow(id);
};
panel.addEventListener('keydown',e=>{
 if(e.target.closest('input,textarea,select,[contenteditable="true"]')||e.altKey)return;
 if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
 const list=order();if(!list.length)return;
 e.preventDefault();e.stopImmediatePropagation();
 let index=list.findIndex(o=>o.id===cursor);
 if(index<0){index=list.findIndex(o=>selObjs.includes(o));if(index<0)index=e.key==='ArrowUp'?list.length: -1;anchor=list[Math.max(0,Math.min(list.length-1,index))].id;}
 const next=e.key==='Home'?0:e.key==='End'?list.length-1:Math.max(0,Math.min(list.length-1,index+(e.key==='ArrowDown'?1:-1))),o=list[next];
 if(e.shiftKey){range(list,o,e.ctrlKey||e.metaKey);return;}
 ranging=false;base=[];cursor=o.id;
 if(!(e.ctrlKey||e.metaKey)){anchor=o.id;selObj(o,false);}
 focusRow(o.id);
});
panel.addEventListener('keyup',e=>{if(e.key==='Shift'){ranging=false;base=[];}});
})();
