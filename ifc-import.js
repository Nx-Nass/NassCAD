/* NASSCAD IFC browser import. web-ifc 0.0.77 (MPL-2.0), bundled locally.
 * Geometry import: IFC2X3 / IFC4 / IFC4X3. The original BIM relationship and
 * property graph is not retained: exported NASSCAD geometry is IFC4 proxies.
 */
'use strict';

const _ifcAssetBase = new URL('.', document.currentScript.src).href;
let _ifcApiPromise = null;
let _ifcImportQueue = Promise.resolve();

function _ifcLoadScript(name){
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(name, _ifcAssetBase).href;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('IFC: missing companion file: ' + name)); };
    document.head.appendChild(script);
  });
}

function _ifcGetApi(){
  if(!_ifcApiPromise){
    _ifcApiPromise = (async () => {
      if(typeof WebIFC === 'undefined') await _ifcLoadScript('web-ifc-api-iife.js');
      if(!globalThis._NASSCAD_IFC_WASM_URL) await _ifcLoadScript('nasscad-ifc-wasm.js');
      const api = new WebIFC.IfcAPI();
      // Embedded data URL supports double-click/file:// and HTTP, without a
      // CDN, a server, CORS headers or a multi-thread WASM worker.
      await api.Init(() => globalThis._NASSCAD_IFC_WASM_URL, true);
      return api;
    })().catch(error => { _ifcApiPromise = null; throw error; });
  }
  return _ifcApiPromise;
}

function _ifcDispose(objects){
  for(const o of objects){
    if(o.mesh.parent) o.mesh.parent.remove(o.mesh);
    o.mesh.geometry.dispose();
    const materials = Array.isArray(o.mesh.material) ? o.mesh.material : [o.mesh.material];
    materials.forEach(m => m.dispose());
  }
}

// Queue direct script calls as well as UI batches: a single WASM instance and
// the global undo/scene state must not be mutated by overlapping imports.
function importIFC(file, opts){
  const task = _ifcImportQueue.then(() => _ifcImportBrowser(file, opts || {}));
  _ifcImportQueue = task.catch(() => {});
  return task;
}

async function _ifcImportBrowser(file, opts){
  const pending = [];
  let api, modelID = -1, committed = false;
  const t0 = performance.now();
  if(!opts.silent) showSpinner('Import IFC', file.name + ' — reading locally…');
  try{
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Avoid passing arbitrary/empty input to the native parser. Header only;
    // geometry is parsed by web-ifc, never by a home-grown STEP parser.
    const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1048576)));
    if(!/^\s*(?:\uFEFF)?\s*ISO-10303-21\s*;/i.test(header) ||
       !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(header))
      throw new Error('This file does not contain a valid IFC (STEP) model.');
    api = await _ifcGetApi();
    await new Promise(resolve => setTimeout(resolve, 0));
    modelID = api.OpenModel(bytes, {COORDINATE_TO_ORIGIN:false, CIRCLE_SEGMENTS:32});
    if(modelID < 0) throw new Error('Unsupported IFC schema or unreadable file.');
    const schema = api.GetModelSchema(modelID);
    const fileLabel = file.name.replace(/\.[^.]+$/, '') || 'IFC';
    const bounds = new THREE.Box3();
    let productCount = 0, skipped = 0, triangles = 0;

    api.StreamAllMeshes(modelID, flat => {
      if(!flat.geometries.size()) return;
      let product = {};
      try { product = api.GetLine(modelID, flat.expressID) || {}; } catch(e){}
      const value = v => v && v.value != null ? String(v.value) : '';
      const name = value(product.Name) || value(product.LongName) || ('IFC_' + flat.expressID);
      const type = api.GetNameFromTypeCode(product.type || api.GetLineType(modelID, flat.expressID));
      let productMade = false;
      for(let part=0; part<flat.geometries.size(); part++){
        const placed = flat.geometries.get(part);
        let handle, geo = null, material = null;
        try{
          handle = api.GetGeometry(modelID, placed.geometryExpressID);
          const vertices = api.GetVertexArray(handle.GetVertexData(), handle.GetVertexDataSize());
          const indices = api.GetIndexArray(handle.GetIndexData(), handle.GetIndexDataSize());
          if(!vertices.length || !indices.length){ skipped++; continue; }
          const count = vertices.length / 6;
          if(!Number.isInteger(count) || indices.length % 3) throw new Error('Invalid IFC mesh #' + flat.expressID);
          const positions = new Float32Array(count*3), normals = new Float32Array(count*3);
          for(let v=0; v<count; v++) for(let k=0; k<3; k++){
            const p = vertices[v*6+k], n = vertices[v*6+k+3];
            if(!Number.isFinite(p) || !Number.isFinite(n)) throw new Error('Invalid IFC coordinate #' + flat.expressID);
            positions[v*3+k] = p; normals[v*3+k] = n;
          }
          const index = new Uint32Array(indices);
          for(const v of index) if(v >= count) throw new Error('Invalid IFC index #' + flat.expressID);
          const tf = placed.flatTransformation;
          if(tf.length !== 16 || !Array.from(tf).every(Number.isFinite)) throw new Error('Invalid IFC placement #' + flat.expressID);
          // web-ifc already returns Y-up placements in METRES regardless of
          // the source unit. Only convert m -> mm, do not rotate a second time.
          // Keep translation in the double precision Object3D position; baking
          // survey coordinates into Float32 vertices would destroy small detail.
          const matrix = new THREE.Matrix4().fromArray(tf);
          const translation = new THREE.Vector3(tf[12]*1000, tf[13]*1000, tf[14]*1000);
          matrix.setPosition(0,0,0);
          matrix.premultiply(new THREE.Matrix4().makeScale(1000,1000,1000));
          if(matrix.determinant() < 0) for(let i=0;i<index.length;i+=3){ const v=index[i+1]; index[i+1]=index[i+2]; index[i+2]=v; }
          geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
          geo.setAttribute('normal', new THREE.BufferAttribute(normals,3));
          geo.setIndex(new THREE.BufferAttribute(index,1));
          geo.applyMatrix4(matrix);
          geo.computeBoundingBox();
          if(![geo.boundingBox.min.x,geo.boundingBox.min.y,geo.boundingBox.min.z,
               geo.boundingBox.max.x,geo.boundingBox.max.y,geo.boundingBox.max.z].every(Number.isFinite))
            throw new Error('Invalid IFC dimensions #' + flat.expressID);
          bounds.union(geo.boundingBox.clone().translate(translation));
          const c = placed.color;
          const clamp = (x, fallback) => Number.isFinite(x) ? Math.min(1,Math.max(0,x)) : fallback;
          const color = new THREE.Color(clamp(c.x,0.7),clamp(c.y,0.7),clamp(c.z,0.7));
          const alpha = clamp(c.w,1);
          const hex = '#' + color.getHexString();
          material = new THREE.MeshPhongMaterial({color:hex, opacity:alpha, transparent:alpha<1,
            shininess:8, specular:0x1a1a1a, side:THREE.DoubleSide});
          const mesh = new THREE.Mesh(geo,material);
          mesh.position.copy(translation); mesh.castShadow = true;
          pending.push({name: name + (flat.geometries.size()>1 ? ' ['+(part+1)+']' : ''),
            type:'csg', mesh, color:hex, isHole:false,
            ifc:{schema, sourceFile:file.name, expressId:flat.expressID, globalId:value(product.GlobalId),
              type, name, description:value(product.Description), partIndex:part}});
          triangles += index.length/3;
          productMade = true;
          geo = null; material = null; // ownership transferred to pending
        } finally {
          if(handle) handle.delete();
          if(geo) geo.dispose();
          if(material) material.dispose();
        }
      }
      if(productMade) productCount++;
    });
    if(!pending.length) throw new Error('No usable 3D geometry in this IFC file.');
    if(!opts.noUndo && typeof undoPush === 'function') undoPush('import IFC');
    const groupId = 'stepgrp_' + (++_stepGroupSeq);
    for(const o of pending){
      o.id = ++objCnt;
      o.stepGroupId = groupId; o.stepGroupLabel = fileLabel;
      scene.add(o.mesh); o.mesh.updateMatrixWorld(true); objs.push(o);
    }
    committed = true;
    selObjs = pending.slice();
    if(opts.fitView !== false && typeof camT !== 'undefined'){
      bounds.getCenter(camT);
      const radius = bounds.getSize(new THREE.Vector3()).length()/2;
      const halfFov = (cam.fov || 45)*Math.PI/360;
      const fitAngle = Math.min(halfFov, Math.atan(Math.tan(halfFov)*(cam.aspect || 1)));
      camA.dist = Math.max(10, radius / Math.sin(fitAngle) * 1.15);
      cam.far = Math.max(cam.far,camA.dist + radius*4);
      cam.updateProjectionMatrix(); updCam();
    }
    updProps(); updOList(); updStats();
    nasLog('OK', 'Import '+schema+' — '+productCount+' element(s), '+pending.length+' mesh(es), '+triangles+
      ' triangles — dimensions and placements kept in mm — '+Math.round(performance.now()-t0)+' ms');
    if(skipped) nasLog('WARN','IFC: '+skipped+' empty representation(s) skipped.');
    nasLog('INFO','IFC: geometry import — the full BIM properties and relationships are not kept when exporting again.');
    return pending;
  } finally {
    try {
      if(api && modelID >= 0) api.CloseModel(modelID);
    } finally {
      if(!committed) _ifcDispose(pending);
      if(!opts.silent) hideSpinner();
    }
  }
}
