/* NassLab original I4 showcase. Derived from nass-demo-engine.js. AGPL-3.0-only.
 * Deterministic mechanical animation and illustrative combustion, not a physics solver.
 */
(function(){
'use strict';
const stage=document.getElementById('homeEngine');
if(!stage)return;
const pauseButton=document.getElementById('enginePause'),resetButton=document.getElementById('engineReset');
const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
const scriptURL=new URL(document.currentScript.src),asset=name=>new URL(name,scriptURL).href;
let started=false,inView=false,engine=null;
function loadThree(){
 if(window.THREE)return Promise.resolve(window.THREE);
 return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=asset('three.js');s.onload=()=>resolve(window.THREE);s.onerror=reject;document.head.appendChild(s);});
}
async function start(){
 if(started)return;started=true;
 try{
  if(!window.DecompressionStream)throw new Error('DecompressionStream unavailable');
  const [THREE,response]=await Promise.all([loadThree(),fetch(asset('nasscad-home-engine.bin'))]);
  if(!response.ok)throw new Error('Engine model unavailable');
  const data=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  engine=createEngine(THREE,data);
  stage.dataset.state='ready';pauseButton.disabled=false;resetButton.disabled=false;
  engine.visibility(inView&&!document.hidden);
 }catch(error){
  stage.dataset.state='fallback';pauseButton.hidden=true;resetButton.hidden=true;
  stage.removeAttribute('tabindex');stage.removeAttribute('aria-keyshortcuts');
  stage.setAttribute('aria-label','NassLab four-cylinder engine preview. Explore the full demo using the link below.');
  console.warn('NASSCAD homepage: showing engine poster.',error);
 }
}
if('IntersectionObserver'in window){
 const observer=new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;if(inView)start();if(engine)engine.visibility(inView&&!document.hidden);},{rootMargin:'80px',threshold:0});observer.observe(stage);
}else{inView=true;start();}
document.addEventListener('visibilitychange',()=>{if(engine)engine.visibility(inView&&!document.hidden);});

function createEngine(THREE,data){
 const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));renderer.outputEncoding=THREE.sRGBEncoding;
 renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
 renderer.setClearColor(0x000000,0);
 renderer.domElement.setAttribute('aria-hidden','true');stage.appendChild(renderer.domElement);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,1,2500),root=new THREE.Group();scene.add(root);
 const resources=new Set(),own=r=>(resources.add(r),r),groups={},profiles=data.camProfiles||{};
 // A small local studio environment gives the original metalwork soft reflections.
 const envCanvas=document.createElement('canvas');envCanvas.width=512;envCanvas.height=256;
 const ec=envCanvas.getContext('2d'),gradient=ec.createLinearGradient(0,0,0,256);
 gradient.addColorStop(0,'#6684ad');gradient.addColorStop(.46,'#e4edfa');gradient.addColorStop(.5,'#263b59');gradient.addColorStop(1,'#080f20');ec.fillStyle=gradient;ec.fillRect(0,0,512,256);
 ec.fillStyle='#f5f8ff';ec.fillRect(35,28,42,100);ec.fillRect(190,18,75,80);ec.fillStyle='#829cb9';ec.fillRect(395,28,28,110);
 const env=own(new THREE.CanvasTexture(envCanvas));env.mapping=THREE.EquirectangularReflectionMapping;
 const materials=new Map();
 for(const p of data.parts){
  const key=p.group||'static';
  if(!groups[key]){const g=new THREE.Group();g.position.fromArray(data.origins?.[key]||[0,0,0]);g.userData.origin=g.position.toArray();groups[key]=g;root.add(g);}
  const geometry=own(new THREE.BufferGeometry());geometry.setAttribute('position',new THREE.Float32BufferAttribute(p.positions,3));geometry.setIndex(p.indices);
  if(data.worldVertices){const o=groups[key].userData.origin;geometry.translate(-o[0],-o[1],-o[2]);}
  if(/^Main bearing saddle [1-5] structural support /.test(p.name)){
   geometry.computeBoundingBox();const base=geometry.boundingBox.min.y,pos=geometry.attributes.position;
   for(let i=0;i<pos.count;i++)pos.setY(i,base+(pos.getY(i)-base)*.5);
  }
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  const dark=/ring|segment|chain|bearing|gasket/i.test(p.name),color=Array.isArray(p.color)?new THREE.Color().setRGB(...p.color):new THREE.Color(p.color||'#b2bdc8');
  const materialKey=color.getHexString()+dark;
  if(!materials.has(materialKey))materials.set(materialKey,own(new THREE.MeshStandardMaterial({color,metalness:dark?.78:.75,roughness:dark?.34:.29,envMap:env,envMapIntensity:.65})));
  const mesh=new THREE.Mesh(geometry,materials.get(materialKey));mesh.name=p.name;groups[key].add(mesh);
 }
 scene.add(new THREE.AmbientLight(0xb8d1ef,.45));
 for(const [color,power,pos]of [[0xfff0df,1.65,[-280,650,250]],[0x7fb9ff,1.1,[380,390,-340]],[0xd0e0ff,.9,[-280,160,-400]]]){const light=new THREE.DirectionalLight(color,power);light.position.fromArray(pos);scene.add(light);}
 const cylinderZ=data.cfg.z,R=data.cfg.R,L=data.cfg.L,period=4*Math.PI,fire=data.cfg.firingOffsets.map(n=>n*Math.PI/180),mod=(x,n)=>(x%n+n)%n;
 const combustion=createCombustionFX(THREE,root,cylinderZ.map(z=>({x:0,z,radius:42.4,headY:228})));
 const valves=Object.entries(groups).flatMap(([key,group])=>{const m=key.match(/^valve-(\d+)-(intake|exhaust)-(\d+)$/);return m?[{group,cylinder:+m[1]-1,type:m[2],base:group.position.y,spring:groups['spring-'+m[1]+'-'+m[2]+'-'+m[3]]}]:[];});
 const sleeveMat=own(new THREE.MeshPhongMaterial({color:0x8eb7cf,transparent:true,opacity:.055,depthWrite:false,side:THREE.DoubleSide,specular:0xcde6f0,shininess:75}));
 for(const z of cylinderZ){const sleeve=new THREE.Mesh(own(new THREE.CylinderGeometry(43.25,43.25,158,40,1,true,0,Math.PI)),sleeveMat);sleeve.position.set(0,146,z);root.add(sleeve);}
 function lift(cycle,type,i,a){
  const profile=profiles[type]?.[i];
  if(profile){let bottomY=0;const sn=Math.sin(-a/2),cs=Math.cos(-a/2);for(const [x,y]of profile)bottomY=Math.min(bottomY,x*sn+y*cs);return Math.max(0,-bottomY-8);}
  const d=mod(cycle*180/Math.PI,720),start=type==='intake'?350:155,end=type==='intake'?590:375;
  return d<start||d>end?0:9*Math.pow(Math.sin(Math.PI*(d-start)/(end-start)),4);
 }
 let angle=35*Math.PI/180,yaw=-1.08,pitch=.24,raf=0,last=null,visible=false,playing=!motion.matches,drag=null,disposed=false;
 function pose(){
  groups.crank.rotation.z=-angle;
  for(let i=0;i<4;i++){
   const phase=angle+(i===1||i===2?Math.PI:0),x=R*Math.sin(phase),y=R*Math.cos(phase),pin=y+Math.sqrt(L*L-x*x);
   groups['piston'+(i+1)].position.set(0,pin,cylinderZ[i]);groups['rod'+(i+1)].position.set(x,y,cylinderZ[i]);groups['rod'+(i+1)].rotation.z=Math.asin(x/L);
   combustion.update(i,mod(angle-fire[i],period),pin+data.cfg.crownOffset+data.cfg.pistonDomeHeight);
  }
  for(const key of ['camIntake','camExhaust'])if(groups[key])groups[key].rotation.z=-angle/2;
  for(const valve of valves){const v=lift(mod(angle-fire[valve.cylinder],period),valve.type,valve.cylinder,angle);valve.group.position.y=valve.base-v;if(valve.spring)valve.spring.scale.y=(17.15-v)/17.15;}
 }
 function cameraPose(){
  const distance=920,target=new THREE.Vector3(0,112,0);
  camera.position.set(Math.sin(yaw)*Math.cos(pitch)*distance,target.y+Math.sin(pitch)*distance,Math.cos(yaw)*Math.cos(pitch)*distance);camera.lookAt(target);
 }
 function draw(){if(disposed)return;pose();cameraPose();renderer.render(scene,camera);}
 function frame(t){
  raf=0;if(!visible||!playing||disposed)return;
  if(last===null||t-last>=1000/30){const dt=last===null?0:Math.min((t-last)/1000,.06);last=t;angle=mod(angle+dt*Math.PI*1.5,period);draw();}
  raf=requestAnimationFrame(frame);
 }
 function sync(){
  pauseButton.textContent=playing?'Ⅱ Pause':'▶ Play';pauseButton.setAttribute('aria-label',playing?'Pause engine animation':'Play engine animation');
  stage.dataset.playing=String(playing&&visible);
  if(visible&&playing&&!raf){last=null;raf=requestAnimationFrame(frame);}else if(!visible||!playing){cancelAnimationFrame(raf);raf=0;last=null;}
 }
 function toggle(){playing=!playing;sync();}
 function reset(){yaw=-1.08;pitch=.24;draw();}
 pauseButton.addEventListener('click',toggle);resetButton.addEventListener('click',reset);
 stage.addEventListener('keydown',e=>{
  if(e.key===' '){e.preventDefault();toggle();return;}
  if(e.key==='Home'){e.preventDefault();reset();return;}
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();yaw+=(e.key==='ArrowLeft'?-.08:e.key==='ArrowRight'?.08:0);pitch=Math.max(-.2,Math.min(.75,pitch+(e.key==='ArrowUp'?.06:e.key==='ArrowDown'?-.06:0)));draw();
 });
 stage.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0)return;drag={x:e.clientX,y:e.clientY};stage.setPointerCapture(e.pointerId);stage.classList.add('dragging');});
 stage.addEventListener('pointermove',e=>{if(!drag)return;yaw-=(e.clientX-drag.x)*.006;pitch=Math.max(-.2,Math.min(.75,pitch+(e.clientY-drag.y)*.004));drag={x:e.clientX,y:e.clientY};draw();});
 const endDrag=()=>{drag=null;stage.classList.remove('dragging');};stage.addEventListener('pointerup',endDrag);stage.addEventListener('pointercancel',endDrag);stage.addEventListener('dblclick',reset);
 motion.addEventListener('change',()=>{playing=!motion.matches;sync();draw();});
 function resize(){const width=stage.clientWidth,height=stage.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();draw();}
 new ResizeObserver(resize).observe(stage);resize();sync();
 function fail(){if(disposed)return;disposed=true;cancelAnimationFrame(raf);combustion.dispose();resources.forEach(r=>r.dispose());renderer.dispose();stage.dataset.state='fallback';pauseButton.hidden=true;resetButton.hidden=true;}
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();fail();});
 window.addEventListener('pagehide',e=>{if(!e.persisted)fail();});
 return {visibility(value){visible=value;sync();}};
}

function createCombustionFX(THREE, scene, specs){
  const root=new THREE.Group();root.name='NASSCAD combustion (visual only)';scene.add(root);
  const maxParticles=10000,resources=new Set(),states=[];
  let count=120;
  const own=v=>(resources.add(v),v);
  const texSize=32,pixels=new Uint8Array(texSize*texSize*4);
  for(let y=0;y<texSize;y++)for(let x=0;x<texSize;x++){
    const r=Math.hypot((x+.5)/texSize*2-1,(y+.5)/texSize*2-1),j=(y*texSize+x)*4;
    pixels[j]=pixels[j+1]=pixels[j+2]=255;pixels[j+3]=Math.round(255*Math.pow(Math.max(0,1-r),2));
  }
  const texture=own(new THREE.DataTexture(pixels,texSize,texSize,THREE.RGBAFormat));texture.needsUpdate=true;texture.magFilter=texture.minFilter=THREE.LinearFilter;
  // Seeded, shared noise texture for the volumetric flame; no image downloads.
  const noiseSize=128,noisePixels=new Uint8Array(noiseSize*noiseSize*4);let seed=0x6a09e667;
  for(let j=0;j<noisePixels.length;j+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;noisePixels[j]=noisePixels[j+1]=noisePixels[j+2]=seed&255;noisePixels[j+3]=255;}
  const noiseTexture=own(new THREE.DataTexture(noisePixels,noiseSize,noiseSize,THREE.RGBAFormat));noiseTexture.needsUpdate=true;noiseTexture.wrapS=noiseTexture.wrapT=THREE.RepeatWrapping;noiseTexture.minFilter=noiseTexture.magFilter=THREE.LinearFilter;
  const items=specs.map((spec,i)=>{
    const group=new THREE.Group();root.add(group);
    const volume=own(new THREE.CylinderGeometry(1,1,1,32,1,false));
    const flashMat=own(new THREE.MeshBasicMaterial({color:0xffdc8b,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide}));
    const flash=new THREE.Mesh(volume,flashMat);group.add(flash);
    const flameMat=own(new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.NormalBlending,side:THREE.BackSide,
      uniforms:{uPhase:{value:0},uPower:{value:0},uBrightness:{value:0},uTemperature:{value:0},uNoise:{value:noiseTexture}},
      // Proxy cylinders are axis aligned: invert their translation/scale to
      // express the camera in local volume coordinates, including orbiting.
      vertexShader:`varying vec3 vP; varying vec3 vEye;
        void main(){vP=position;vec3 scale=vec3(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz),length(modelMatrix[2].xyz));
          vEye=(cameraPosition-modelMatrix[3].xyz)/scale;
          gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader:`precision highp float;
        varying vec3 vP; varying vec3 vEye;
        uniform float uPhase; uniform float uPower; uniform float uBrightness; uniform float uTemperature; uniform sampler2D uNoise;
        float noise3(vec3 p){float z=floor(p.z),f=fract(p.z);f=f*f*(3.0-2.0*f);
          vec2 uv=(p.xy+vec2(37.0,17.0)*z+0.5)/128.0;
          return mix(texture2D(uNoise,uv).r,texture2D(uNoise,uv+vec2(37.0,17.0)/128.0).r,f);}
        float turbulence(vec3 p){return noise3(p*5.0)*0.57+noise3(p*11.0+13.0)*0.28+noise3(p*23.0+31.0)*0.15;}
        vec3 fireColor(float heat){
          vec3 col=mix(vec3(0.9,0.045,0.002),vec3(1.0,0.34,0.015),smoothstep(0.05,0.43,heat));
          col=mix(col,vec3(1.0,0.88,0.1),smoothstep(0.4,0.72,heat));
          return mix(col,vec3(1.0,0.99,0.86)*1.18,smoothstep(0.68,0.93,heat));}
        void main(){
          vec3 ro=vEye,rd=normalize(vP-ro);
          float A=dot(rd.xz,rd.xz),B=dot(ro.xz,rd.xz),D=B*B-A*(dot(ro.xz,ro.xz)-1.0);
          if(D<0.0)discard;
          float a=max(A,0.000001),root=sqrt(max(0.0,D));
          float t0=(-B-root)/a,t1=(-B+root)/a;
          if(A<0.000001){if(dot(ro.xz,ro.xz)>1.0)discard;t0=-10000.0;t1=10000.0;}
          if(abs(rd.y)>0.000001){float y0=(-0.5-ro.y)/rd.y,y1=(0.5-ro.y)/rd.y;t0=max(t0,min(y0,y1));t1=min(t1,max(y0,y1));}
          else if(abs(ro.y)>0.5)discard;
          t0=max(t0,0.0);if(t1<=t0)discard;
          float stepLength=(t1-t0)/28.0;vec3 rgb=vec3(0.0);float alpha=0.0;
          for(int i=0;i<28;i++){
            vec3 p=ro+rd*(t0+(float(i)+0.5)*stepLength);
            vec3 drift=vec3(sin(uPhase*3.0)*0.15,-uPhase*1.6,uPhase*0.7);
            float n=turbulence(p+drift);
            float radial=length(p.xz);
            float edge=1.0-radial*radial;
            float vertical=smoothstep(-0.5,-0.36,p.y)*(1.0-smoothstep(0.36,0.5,p.y));
            float density=max(0.0,edge+(n-0.5)*1.5-0.24)*vertical;
            float heat=clamp((density*1.45+(n-0.5)*0.55)*uTemperature+0.22*uTemperature,0.0,1.0);
            float opacity=1.0-exp(-density*stepLength*(3.2+uPower*3.0));
            rgb+=(1.0-alpha)*opacity*fireColor(heat);alpha+=(1.0-alpha)*opacity;
          }
          float envelope=smoothstep(0.0,0.08,uPower);
          if(alpha<0.01)discard;
          // Radiance cools and fades independently of opacity: the earlier
          // volume stayed orange-bright even while its opacity envelope fell.
          gl_FragColor=vec4(rgb/max(alpha,0.001)*uBrightness,alpha*envelope);
        }`
    }));
    const flame=new THREE.Mesh(volume,flameMat);group.add(flame);
    const positions=new Float32Array(maxParticles*3),colors=new Float32Array(maxParticles*3);
    for(let k=0;k<maxParticles;k++){colors[k*3]=1;colors[k*3+1]=.3+.65*((k*37%97)/97);colors[k*3+2]=.03+.2*((k*17%89)/89);}
    const pg=own(new THREE.BufferGeometry());pg.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));pg.setAttribute('color',new THREE.BufferAttribute(colors,3));
    pg.setDrawRange(0,count);
    const pm=own(new THREE.PointsMaterial({size:5,map:texture,vertexColors:true,transparent:true,opacity:0,depthWrite:false,blending:THREE.NormalBlending,sizeAttenuation:true}));
    const points=new THREE.Points(pg,pm);points.frustumCulled=false;group.add(points);
    const light=new THREE.PointLight(0xffb35c,0,180,2);group.add(light);
    const haloMat=own(new THREE.SpriteMaterial({map:texture,color:0xffb35c,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending}));
    const halo=new THREE.Sprite(haloMat);group.add(halo);
    return {spec,group,flash,flame,points,light,halo,positions,index:i};
  });
  let enabled=true,mode='flame',disposed=false;
  function update(index,cycle,pistonCrown){
    if(disposed)return;
    const f=items[index],s=f.spec,clearance=.6;
    const bottom=pistonCrown+clearance,top=s.headY-clearance,gap=Math.max(.001,top-bottom);
    // Spark 12 degrees BTDC. Hot expansion remains visible right through
    // power-stroke BDC (+180 degrees); it stops as the exhaust stroke begins.
    // The next cylinder's advance can overlap the previous one's last 12°.
    const advance=Math.PI/15,duration=Math.PI+advance;
    const burn=((cycle+advance)%(4*Math.PI)+4*Math.PI)%(4*Math.PI);
    const active=enabled&&top>bottom&&burn<=duration+1e-9,p=Math.min(1,burn/duration);
    // Ignition rises smoothly over the 12 degrees before TDC. From TDC onward
    // the radiance is strictly non-increasing, while the gas front continues
    // expanding with the piston all the way to BDC.
    const strokeProgress=Math.max(0,Math.min(1,(burn-advance)/Math.PI));
    const ignition=Math.max(0,Math.min(1,burn/advance));
    const rise=ignition*ignition*(3-2*ignition);
    const brightness=active?rise*(.12+3.88*Math.pow(1-strokeProgress,2)):0;
    const temperature=active?.25+.75*Math.pow(1-strokeProgress,.65):0;
    const power=active?rise*(1-.7*strokeProgress):0;
    const flashPower=active?rise*(.65*Math.exp(-12*strokeProgress)+.06*Math.pow(1-strokeProgress,2)):0;
    f.group.visible=active;
    const front=Math.min(1,burn/(100*Math.PI/180));
    const radius=Math.min(s.radius-.8,Math.max(2,s.radius*(.08+2.5*front))),height=Math.min(gap,Math.max(.3,gap*Math.min(1,front*3.5)));
    const mid=top-height/2;
    for(const mesh of [f.flash,f.flame]){mesh.position.set(s.x,mid,s.z);mesh.scale.set(radius,height,radius);}
    f.flash.material.opacity=flashPower*(mode==='flame'?.35:1);
    f.flash.material.color.setRGB(brightness*.8,brightness*(.4+.4*temperature),brightness*(.04+.5*temperature));
    f.flame.visible=mode==='flame';
    f.flame.material.uniforms.uPhase.value=burn;f.flame.material.uniforms.uPower.value=power;
    f.flame.material.uniforms.uBrightness.value=brightness;f.flame.material.uniforms.uTemperature.value=temperature;
    f.points.visible=mode!=='flash';f.points.material.opacity=power*(mode==='flame'?.23:.9);
    // One uniform tint multiplies the preallocated vertex colours. It adds
    // hot white/yellow sparks initially without rewriting 10k colour buffers.
    f.points.material.color.setRGB(brightness*.7,brightness*(.4+.6*temperature),brightness*(.1+3*temperature));
    // Do not update the three hidden cylinders' buffers every frame. Capacity
    // is allocated once; the slider changes drawRange without reallocations.
    if(active&&mode!=='flash')for(let k=0;k<count;k++){
      const seed=((k*0.7548776662466927)%1),t=((k*0.5698402909980532)%1);
      const a=k*2.399963229728653+p*5,rr=radius*Math.sqrt(seed)*.96;
      f.positions[k*3]=s.x+Math.cos(a)*rr;
      f.positions[k*3+1]=top-height*(.03+.94*t);
      f.positions[k*3+2]=s.z+Math.sin(a)*rr;
    }
    if(active&&mode!=='flash'&&count){
      const attr=f.points.geometry.attributes.position;attr.updateRange.offset=0;attr.updateRange.count=count*3;attr.needsUpdate=true;
    }
    f.light.position.set(s.x,top-Math.min(gap/2,4),s.z);f.light.intensity=active?brightness*3.2+flashPower*4:0;
    f.light.color.setRGB(1,.36+.61*temperature,.035+.45*temperature);
    f.halo.position.set(s.x,mid,s.z);f.halo.scale.set(20+radius*1.5,20+radius*1.5,1);
    f.halo.material.opacity=active?Math.min(.88,(.12+brightness*.15)*power+flashPower*.32):0;
    f.halo.material.color.setRGB(brightness*.6,brightness*(.2+.4*temperature),brightness*(.015+.2*temperature));
    states[index]={active,burn,progress:active?p:0,strokeProgress:active?strokeProgress:0,bottom,top,radius,height,power,brightness,temperature,flashPower,cycle,lightIntensity:f.light.intensity,particleCount:count};
  }
  return {root,update,setEnabled(v){enabled=!!v;if(!enabled)root.visible=false;else root.visible=true;},setMode(v){mode=['flash','particles','flame'].includes(v)?v:'flame';},
    setParticleCount(v){const n=Number(v);if(!Number.isFinite(n))return count;count=Math.max(0,Math.min(maxParticles,Math.round(n)));items.forEach(f=>f.points.geometry.setDrawRange(0,count));return count;},getParticleCount(){return count;},getState(){return states.map(s=>({...s}));},
    dispose(){if(disposed)return;disposed=true;scene.remove(root);resources.forEach(r=>r.dispose());resources.clear();}
  };
}


})();
