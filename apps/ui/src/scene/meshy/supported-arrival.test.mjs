import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {readGlbGeometry} from '../../../assets-src/den/read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import {actorEnvelope} from './actor-envelope.mjs';
import {createApprovedGarden} from './approved-garden.mjs';
import {createApprovedNavigation} from './approved-navigation.mjs';
import {leisurePlaces} from './approved-plan.mjs';

globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
test('55-E/F: actual Developer enters and exits bed 4 with supported foot contacts and a clear swept body',()=>{
 const garden=createApprovedGarden(),world=createApprovedNavigation(garden);
 const source=readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public/den/models/characters/developer.glb.gz',import.meta.url))));
 const factory=createPandaAppearanceFactory({characters:{developer:source},approvedOnly:true}),panda=factory.createPanda('developer',{runtime:'codex'});
 const dock=garden.docks.find(d=>d.id==='codex:developer');panda.model.position.fromArray(dock.position);panda.model.rotation.y=dock.yaw;
 const actor={panda,home:panda.model.position.clone(),dock,baseYaw:dock.yaw,envelope:actorEnvelope(panda,null,{oriented:true})};
 try{
  const spot=leisurePlaces().find(s=>s.id==='leisure:rest:3'),arrival=world.approach(actor,spot);
  assert.ok(arrival?.length,'a supported short approach exists');
  assert.ok(arrival.some(p=>p.airborne),'the raised bed requires an explicit lift rather than walking through its base');
  for(const p of arrival){assert.ok(world.fits(p,actor.envelope,p.yaw),'actual full body clears at '+JSON.stringify(p));if(!p.airborne)assert.equal(world.supported(actor,p,p.yaw),true,'both feet have real support');}
  for(const progress of [0,.25,.5,.75,1]){const pose=panda.rig.poseMount(progress);for(const side of ['L','R'])assert.equal(pose.feet[side].planted,progress===0||progress===1,'only takeoff and landing claim planted feet');}
  assert.deepEqual([arrival.at(-1).x,arrival.at(-1).y,arrival.at(-1).z],spot.position.toArray());
  const reverse=world.approach(actor,spot,{reverse:true});assert.ok(reverse?.length);for(const p of reverse)assert.ok(world.fits(p,actor.envelope,p.yaw));
  assert.equal(world.segment({x:-23,y:.36,z:0},spot.position,actor.envelope,Math.atan2(spot.face.x-spot.position.x,spot.face.z-spot.position.z)),false,'old blended side entry remains blocked');
 }finally{factory.dispose();garden.dispose();}
});
