// Preserve the web engine API while Electron exchanges binary messages only.
(() => {
  const api=window.electronAPI;if(!api?.isElectron)return;
  const browserFetch=window.fetch.bind(window);let sequence=0;
  window.fetch=async function(input,init={}) {
    const url=new URL(typeof input==='string'?input:input.url || input,location.href);
    if (!['127.0.0.1','localhost'].includes(url.hostname) || url.port!=='8765') return browserFetch(input,init);
    const signal=init.signal || input?.signal || new AbortController().signal;
    if(signal.aborted) throw signal.reason || new DOMException('Request aborted','AbortError');
    const method=String(init.method || input?.method || 'GET').toUpperCase(), route=url.pathname+url.search;
    let body=null;
    if(method!=='GET' && method!=='HEAD'){const source=init.body;body=source?.nasscadFileToken?source:source instanceof ArrayBuffer || ArrayBuffer.isView(source)?source:source instanceof Blob?await source.arrayBuffer():await new Response(source).arrayBuffer();}
    const id=++sequence;let controller, pendingAck=false, ended=false, rejectAbort, streamError;
    const abortPromise=new Promise((_,reject)=>{rejectAbort=reject});
    const dispose=()=>{api.medusaUnsubscribe(id);signal.removeEventListener('abort',abort)};
    const abort=()=>{if(ended)return;ended=true;api.medusaCancel(id);dispose();const error=signal.reason||new DOMException('Request aborted','AbortError');controller.error(error);rejectAbort(error)};
    const stream=new ReadableStream({
      start(c){controller=c},
      pull(){if(pendingAck){pendingAck=false;api.medusaAck(id)}},
      cancel(){if(!ended){ended=true;api.medusaCancel(id);dispose()}}
    });
    // This stream can be aborted before fetch resolves; mark its rejection handled.
    api.medusaSubscribe(id,frame=>{
      if(ended)return;
      if(frame.error){ended=true;dispose();streamError=new Error(frame.error);controller.error(streamError);return}
      if(frame.end){ended=true;dispose();controller.close();return}
      if(frame.bytes){controller.enqueue(new Uint8Array(frame.bytes));pendingAck=true;if(controller.desiredSize>0 || ['/ping','/log','/stepheld'].includes(url.pathname)){pendingAck=false;api.medusaAck(id)}}
    });
    signal.addEventListener('abort',abort,{once:true});
    try {
      const meta=await Promise.race([api.medusaRequest(id,method,route,body),abortPromise]);
      const response=new Response(meta.status===204?null:stream,{status:meta.status,headers:{'Content-Type':meta.type}});
      for(const name of ['arrayBuffer','text','json','blob']){const consume=response[name].bind(response);response[name]=async()=>{try{return await consume()}catch(error){throw streamError || error}};}
      return response;
    } catch(error){if(!ended){ended=true;api.medusaCancel(id);dispose();controller.error(error)}throw error}
  };
})();
