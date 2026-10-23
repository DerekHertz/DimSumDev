import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {buildLaunchOptions} from '../../../ci-cd/launch-options.mjs';
import {lightenScene} from '../../../ci-cd/light-scene.mjs';

test('the approved garden keeps 24 owned residents, runs their routines, holds selection and respects reduced motion', {timeout:90000},async()=>{
 let server,browser;
 try{
  server=await createServer({configFile:'apps/ui/vite.config.mjs',configLoader:'native',server:{port:0,host:'127.0.0.1'},logLevel:'silent'});await server.listen();
  browser=await chromium.launch(buildLaunchOptions());const context=await browser.newContext({reducedMotion:'no-preference',viewport:{width:1200,height:800}});
  await lightenScene(context,{frameDelayMs:16});const page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  const snapshot={schema:1,seq:1,tickets:[],frontier:[],usage:null,requests:[],agents:[],placements:[],meetings:[]};
  await page.route('**/events',r=>r.fulfill({contentType:'text/event-stream',body:`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`}));
  await page.route('**/state',r=>r.fulfill({json:snapshot}));await page.route('**/metrics',r=>r.fulfill({json:{throughput:{windows:[]},tokensByRole:{},incidentsByTool:{}}}));await page.route('**/session',r=>r.fulfill({status:404,json:{}}));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(()=>{const button=document.querySelector('.den-entry button');return button&&button.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
  const initial=await page.evaluate(async()=>{
   const fiber=performance.getEntriesByType('resource').find(r=>r.name.includes('/@react-three_fiber.js'));
   const {_roots}=await import(fiber.name);const state=_roots.get(document.querySelector('canvas')).store.getState();
   const world=state.scene.getObjectByName('Dim Sum Dev · plush bamboo garden'),residents={};
   world.traverse(node=>{if(node.userData.actorKey)residents[node.userData.actorKey]=node;});
   const pond=world.getObjectByName('Proposed pond structure'),fishBatches=[];
   pond?.traverse(node=>{if(node.isMesh&&node.name.endsWith(' · material batch')&&node.material?.color?.getHexString()==='d47d68')fishBatches.push(node);});
   const outfits=Object.entries(residents).map(([id,model])=>{
    const garment=model.getObjectByName('Shared-rig outfit'),skins=[];model.traverse(node=>{if(node.isSkinnedMesh)skins.push(node);});
    return {id,species:model.userData.species,count:garment?.children.length??0,shared:skins.length>0&&skins.every(node=>node.skeleton===skins[0].skeleton),textured:skins.some(node=>(Array.isArray(node.material)?node.material:[node.material]).some(material=>material.map))};
   });
   window.routineProbe={world,residents,fishBatches:fishBatches.map(node=>node.name)};
   return {homes:Object.fromEntries(Object.entries(residents).map(([id,model])=>[id,model.userData.home.toArray()])),pond:!!pond,fishBatches:fishBatches.length,outfits,residentIds:Object.keys(residents)};
  });
  assert.equal(initial.residentIds.length,24,'only the signed active residents have physical actor identities');
  assert.equal(initial.pond,true,'the approved pond is present in the assembled garden');assert.equal(initial.fishBatches,1,'the three signed coral fish bodies survive in the pond’s coral material batch');
  assert.deepEqual([...new Set(initial.outfits.filter(outfit=>outfit.species).map(outfit=>outfit.species))].sort(),['cloud-dragon','cloud-tortoise','fox','giant-panda','golden-monkey','jiao','lion','lucky-cat','pangolin','red-crowned-crane','red-panda','river-otter','sika-deer']);
  assert.ok(initial.outfits.every(outfit=>(outfit.species||outfit.count>0)&&outfit.shared&&outfit.textured),'actual residents retain textured outfits on their shared skeleton');
  await page.waitForFunction(()=>Object.values(window.routineProbe.residents).some(model=>model.position.distanceTo(model.userData.home)>.05),null,{timeout:30000});
  const moved=await page.evaluate(()=>Object.entries(window.routineProbe.residents).filter(([,model])=>model.position.distanceTo(model.userData.home)>.05).map(([id])=>id));
  assert.ok(moved.length>0,'the live frame loop moves an idle resident along an approved routine');
  assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(window.routineProbe.residents).map(([id,model])=>[id,model.userData.home.toArray()]))),initial.homes,'routines preserve every resident’s owned home');
  assert.ok(await page.evaluate(()=>{
   const model=window.routineProbe.residents.developer,skins=[];model.traverse(node=>{if(node.isSkinnedMesh)skins.push(node);});
   return skins.length>0&&skins.every(mesh=>{const positions=mesh.geometry.attributes.position,point=mesh.position.clone();for(let i=0;i<positions.count;i+=Math.max(1,Math.floor(positions.count/40))){point.fromBufferAttribute(positions,i);mesh.applyBoneTransform(i,point);if(!point.toArray().every(Number.isFinite))return false;}return true;});
  }),'actual resident body and outfit vertices stay finite during the routine animation');
  const key=await page.evaluate(()=>{
   const {world,residents}=window.routineProbe,id='developer';world.__r3f.handlers.onClick({object:residents[id],stopPropagation(){}});return id;
  });
  const card=page.getByRole('region',{name:'Selected panda'});await card.waitFor();assert.match(await card.innerText(),/Resident · no agent running/);
  await page.waitForTimeout(200);const held=await page.evaluate(id=>window.routineProbe.residents[id].getObjectByName('Spine').scale.toArray(),key);
  await page.waitForTimeout(350);assert.deepEqual(await page.evaluate(id=>window.routineProbe.residents[id].getObjectByName('Spine').scale.toArray(),key),held,'selection holds the actual resident pose');
  await page.getByRole('button',{name:'Close panda card'}).click();await card.waitFor({state:'hidden'});
  await page.waitForFunction(({id,held})=>window.routineProbe.residents[id].getObjectByName('Spine').scale.toArray().some((v,j)=>Math.abs(v-held[j])>.001),{id:key,held});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>{
   const current=Object.values(window.routineProbe.residents).map(model=>[...model.position.toArray(),...model.getObjectByName('Spine').scale.toArray()]);
   const stable=JSON.stringify(current)===JSON.stringify(window.routineProbe.previousReduced);window.routineProbe.previousReduced=current;return stable;
  },null,{timeout:10000});
  const safe=await page.evaluate(async()=>{
   const [{createApprovedGarden},{createApprovedNavigation},{CAST_PROFILES},{castCharacterId},{BAO_PRODUCTION},{CHARACTER_PROFILES}]=await Promise.all([
    import('/src/scene/meshy/approved-garden.mjs'),import('/src/scene/meshy/approved-navigation.mjs'),import('/src/scene/meshy/cast-profiles.mjs'),import('/src/scene/meshy/cast.mjs'),import('/src/scene/meshy/bao-profile.mjs'),import('/src/scene/meshy/character-profiles.mjs')]);
   const garden=createApprovedGarden(),navigation=createApprovedNavigation(garden);
   try{return Object.entries(window.routineProbe.residents).map(([id,model])=>{
    const {roleId,runtime,species}=model.userData;
    const profile=roleId==='orchestrator'&&runtime==='claude'?BAO_PRODUCTION:CAST_PROFILES[castCharacterId(roleId,runtime)]||CHARACTER_PROFILES[roleId];
    if(!profile?.foot||profile.id!==species)throw new Error('Missing or mismatched production rig profile for '+id);
    const panda={model,rig:{profile}},position=model.position,yaw=model.rotation.y;
    const homeContact=position.distanceTo(model.userData.home)<1e-6&&[-1,1].every(side=>{
     const x=side*profile.foot.x*model.scale.x,z=profile.foot.z*model.scale.x;
     const floor=navigation.supportAt(position.x+x*Math.cos(yaw)+z*Math.sin(yaw),position.z-x*Math.sin(yaw)+z*Math.cos(yaw));
     return floor!==null&&position.y>=floor-.025&&position.y-floor<.075;
    });
    return {id,supported:navigation.supported({panda},position,yaw)||homeContact,home:model.userData.home.toArray()};
   });}finally{garden.dispose();}
  });
  assert.equal(safe.length,24,'support validation covers every signed resident');
  assert.ok(safe.every(row=>row.supported),'every reduced-motion body remains supported at home or its last safe position');
  assert.deepEqual(Object.fromEntries(safe.map(row=>[row.id,row.home])),initial.homes,'safe freeze retains every owned home even when a return is obstructed');
  const paused=await page.evaluate(()=>({fishBatches:window.routineProbe.fishBatches,residents:Object.values(window.routineProbe.residents).map(model=>[...model.position.toArray(),...model.getObjectByName('Spine').scale.toArray()])}));
  await page.waitForTimeout(350);
  assert.deepEqual(await page.evaluate(()=>({fishBatches:window.routineProbe.fishBatches,residents:Object.values(window.routineProbe.residents).map(model=>[...model.position.toArray(),...model.getObjectByName('Spine').scale.toArray()])})),paused,'reduced motion holds supported residents without gait or idle sway and leaves signed pond figures static');
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 }finally{await browser?.close();await server?.close();}
});
