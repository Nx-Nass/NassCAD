const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {_electron}=require('playwright');
const repo=path.resolve(__dirname,'..','..');
(async()=>{
 const html=fs.readFileSync(path.join(repo,'NASSCAD_V4_7_0.htm'),'utf8');
 assert.match(html,/name="license" content="AGPL-3.0-only/);
 assert.match(html,/id="nass-license-info"/);assert.match(html,/feedback\.html/);
 const vm=require('node:vm');let scripts=0;
 for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/\bsrc=|application\/ld\+json/.test(m[1]))continue;
  new vm.Script(m[2],{filename:`inline-${++scripts}.js`});
 }
 const app=await _electron.launch({executablePath:require('electron'),args:[path.join(repo,'DESKTOP_SOURCE'),'--user-data-dir='+path.resolve(repo,'DESKTOP_SOURCE/work/ui-regression-profile')],timeout:60000});
 const errors=[];
 try{
  const page=await app.firstWindow({timeout:60000});page.on('pageerror',e=>errors.push(e.message));
  await page.waitForLoadState('load');await page.waitForFunction(()=>window.NASSWelcome&&window.stepCacheClear);
  assert.equal(await page.locator('#nass-welcome').isVisible(),false);
  await page.locator('#welcome-mi').click();assert.equal(await page.locator('#nass-welcome').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#nass-welcome').isVisible(),false);
  await page.locator('#welcome-mi').click();await page.locator('#welcome-mi').click();assert.equal(await page.locator('#nass-welcome').isVisible(),false);
  assert.equal((await page.evaluate(()=>electronAPI.medusaStatus())).running,true);
  const cacheResult=await page.evaluate(async()=>{
   const db=await _stepCacheOpen();
   await new Promise((resolve,reject)=>{const tx=db.transaction(_STEP_CACHE_STORE,'readwrite');const st=tx.objectStore(_STEP_CACHE_STORE);st.put({hash:'test-NSTP',ts:Date.now()});st.put({hash:'test-NSPG',ts:Date.now()});tx.oncomplete=resolve;tx.onerror=reject;});
   const count=await _stepCacheCount();const ok=await stepCacheClear({confirm:false});const after=await _stepCacheCount();
   _stepCacheOff=true;
   const disabled=await stepCacheClear({confirm:false});
   return {count,ok,after,disabled};
  });
  assert.ok(cacheResult.count>=2);assert.equal(cacheResult.ok,true);assert.equal(cacheResult.after,0);assert.equal(cacheResult.disabled,true);
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('nasscad:medusa-log');ipcMain.handle('nasscad:medusa-log',()=> 'Import [████████████░░░░░░░░░░░░] 50%  <img src=x onerror=alert(1)>\nReady');});
  await page.locator('#desktop-medusa-button').click();
  await page.waitForSelector('.mdz-bar-fill');
  assert.equal(await page.locator('.mdz-bar-fill').evaluate(el=>el.style.width),'50%');
  assert.equal(await page.locator('#desktop-medusa img').count(),0);
  await page.locator('#desktop-medusa').evaluate(el=>{el.style.width='440px';});
  assert.equal(await page.locator('.mdz-bar').evaluate(el=>getComputedStyle(el).display),'flex');
  assert.equal(await page.locator('canvas').count()>0,true);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({inlineScripts: scripts,startAndEscape:'pass',nativeEngine:'running',cache:cacheResult,progress:'50%, safe text, flex layout',pageErrors:errors},null,2));
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
