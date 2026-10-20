import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../../ci-cd/light-scene.mjs';
import {GROVE_ROLES} from './grove-style.mjs';

let server,browser,page;const errors=[],actions=[];
before(async()=>{
 server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
 browser=await chromium.launch(buildLaunchOptions());
 page=await browser.newPage({viewport:{width:1280,height:1024},deviceScaleFactor:1,reducedMotion:'reduce'});
 await lightenScene(page,{skipDraws:false,frameDelayMs:200});
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')actions.push(r.url());});
 await page.goto(server.resolvedUrls.local[0]+'grove-review.html');await page.waitForFunction(()=>window.groveReview?.ready,{},{timeout:60000});
 if(process.env.GROVE_EVIDENCE_DIR)await mkdir(process.env.GROVE_EVIDENCE_DIR,{recursive:true});
},{timeout:90000});
after(async()=>{await browser?.close();await server?.close();});

for(const role of Object.keys(GROVE_ROLES))test('actual rig · '+role+' · runtime pair, poses and both lighting schemes',{timeout:30000},async t=>{
 await page.selectOption('#role',role);
 await page.emulateMedia({reducedMotion:'no-preference'});
 const result=await page.evaluate(()=>{
  const r=window.groveReview;
  r.setPose('walk');r.render(0);const start=r.stats().poses;
  r.render(.42);const walking=r.stats().poses;
  r.setPose('greeting');r.render(.42);const greeting=r.stats().poses;
  r.setPose('idle');r.render(1.2);const idle=r.stats().poses;
  r.setPose('reduced');const reduced=r.stats();
  return {start,walking,greeting,idle,reduced};
 });
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.deepEqual(result.reduced.runtimes,['claude','codex']);assert.equal(result.reduced.instances,2);
 assert.equal(result.reduced.scales[0],result.reduced.scales[1]);assert.ok(result.reduced.drawCalls>5);assert.equal(result.reduced.paused,true);
 assert.notDeepEqual(result.start[0].paw,result.walking[0].paw,'walking moves the attached paw');
 assert.ok(result.greeting[0].greeting<-1.4,'greeting deforms the left shoulder');
 assert.notDeepEqual(result.idle[0].head,result.reduced.poses[0].head,'idle breathing moves the head');
 for(const theme of ['light','dark']){
  await page.selectOption('#theme',theme);
  assert.equal(await page.evaluate(()=>window.groveReview.stats().role),role);
  await page.locator('#status').filter({hasText:'Actual shared rig · '+role}).waitFor();
  if(process.env.GROVE_EVIDENCE_DIR)await page.screenshot({path:process.env.GROVE_EVIDENCE_DIR+'/'+role+'-'+theme+'.png',fullPage:true});
 }
 t.diagnostic(role+' rendered with '+result.reduced.drawCalls+' draw calls');
 assert.deepEqual(errors,[]);assert.deepEqual(actions,[],'appearance review never dispatches backend work');
});

test('actual rig review releases both figures',{timeout:10000},async()=>{
 await page.evaluate(()=>window.groveReview.dispose());assert.equal(await page.evaluate(()=>window.groveReview.stats().instances),0);
});

test('cached portrait authoring renders the shared wardrobe and runner without legacy prop assets',{timeout:30000},async()=>{
 const result=await page.evaluate(async()=>{
  const {renderRolePortraits}=await import('/assets-src/den/render-role-portraits.mjs'),images=[];
  const report=await renderRolePortraits((role,data)=>{images.push({role,webp:data.startsWith('data:image/webp;base64,'),length:data.length});});
  return {report,images};
 });
 assert.equal(result.report.count,18);assert.equal(result.report.runtime,'claude');
 assert.ok(result.images.some(image=>image.role==='runner'));
 assert.ok(result.images.every(image=>image.webp&&image.length>10000));
 assert.deepEqual(errors,[]);
});
