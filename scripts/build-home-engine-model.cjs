// NassLab — AGPL-3.0-only. Regenerate the homepage model from the original demo.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'..');
const demo=fs.readFileSync(path.join(root,'nass-demo-engine.js'),'utf8');
const packed=demo.match(/const source='([^']+)'/);
if(!packed)throw new Error('Original engine geometry not found in nass-demo-engine.js');
const data=JSON.parse(zlib.gunzipSync(Buffer.from(packed[1],'base64')));
// Hide the same casing and manifold components as the demonstration's mechanism view.
data.parts=data.parts.filter(p=>!p.cutaway&&!p.ghost&&!/cover|sump|crankcase|intake$|exhaust$/.test(p.group||'')&&!/head gasket|cylinder head bolt/i.test(p.name)&&p.name!=='Timing tensioner pulley');
for(const p of data.parts)p.positions=p.positions.map(n=>Math.round(n*1000)/1000);
const bytes=zlib.gzipSync(JSON.stringify(data),{level:9});
fs.writeFileSync(path.join(root,'WEBSITE_SOURCE','nasscad-home-engine.bin'),bytes);
console.log(`Homepage engine: ${data.parts.length} visible parts, ${bytes.length} bytes.`);
