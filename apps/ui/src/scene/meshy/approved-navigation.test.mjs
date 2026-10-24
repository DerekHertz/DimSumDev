import test from 'node:test';
import assert from 'node:assert/strict';
import {createApprovedNavigation} from './approved-navigation.mjs';

test('footprint grounding spans shallow floor seams but refuses missing support and obstructed bodies',()=>{
 const garden={inside:()=>true,assets:{},docks:[],surfaces:[
  {min:[-2,0,-2],max:[0,.245,2],supportTop:.245},
  {min:[0,0,-2],max:[2,.315,2],supportTop:.315}
 ],obstacles:[]};
 const actor={panda:{model:{scale:{x:1}},rig:{profile:{foot:{x:.4,z:0}}}},envelope:{radius:.6,height:2}};
 const world=createApprovedNavigation(garden),p={x:0,y:.36,z:0};
 assert.equal(world.supported(actor,p,0),false);
 const grounded=world.groundedPosition(actor,p,0);
 assert.ok(grounded);assert.equal(grounded.x,p.x);assert.equal(grounded.z,p.z);assert.ok(world.supported(actor,grounded,0));
 const blocked=createApprovedNavigation({...garden,obstacles:[{min:[-.6,.25,-.6],max:[.6,1,.6]}]});
 assert.equal(blocked.groundedPosition(actor,p,0),null);
 const cliff=createApprovedNavigation({...garden,inside:x=>x>=0});
 assert.equal(cliff.groundedPosition(actor,p,0),null);
});

test('a sliced body is constructed once per fit, rather than once per nearby obstacle',()=>{
 let reads=0;
 const slices=Array.from({length:16},(_,i)=>({get min(){reads++;return [-.5,i*.1,-.5];},get max(){reads++;return [.5,(i+1)*.1,.5];}}));
 const garden={inside:()=>true,assets:{},docks:[],obstacles:Array.from({length:8000},()=>({min:[1.5,0,1.5],max:[1.6,3,1.6]}))};
 const navigation=createApprovedNavigation(garden);
 assert.equal(navigation.fits({x:0,y:.36,z:0},{radius:3,height:2,bounds:{min:[-2,0,-2],max:[2,2,2]},slices}),true);
 assert.ok(reads<256,`sliced footprint work must be independent of obstacle count; read bounds ${reads} times`);
});

test('optimized collision checks match exhaustive sliced-body checks at rotated poses',()=>{
 let seed=43;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const rect=(p,e,yaw)=>{const b=e.bounds||{min:[-e.radius,0,-e.radius],max:[e.radius,e.height,e.radius]};const v=[];for(const x of [b.min[0],b.max[0]])for(const z of [b.min[2],b.max[2]])v.push({x:p.x+x*Math.cos(yaw)+z*Math.sin(yaw),z:p.z-x*Math.sin(yaw)+z*Math.cos(yaw)});return v;};
 const overlap=(a,b)=>{for(const polygon of [a,b])for(const [i,j]of [[0,1],[0,2]]){const x=polygon[j].z-polygon[i].z,z=polygon[i].x-polygon[j].x,pa=a.map(p=>p.x*x+p.z*z),pb=b.map(p=>p.x*x+p.z*z);if(Math.max(...pa)<=Math.min(...pb)+.025||Math.max(...pb)<=Math.min(...pa)+.025)return false;}return true;};
 const obstacles=Array.from({length:100},()=>{const p={x:random()*20-10,z:random()*20-10},vertices=rect(p,{radius:.15+random()},random()*Math.PI);return {vertices,min:[Math.min(...vertices.map(v=>v.x)),random(),Math.min(...vertices.map(v=>v.z))],max:[Math.max(...vertices.map(v=>v.x)),2+random(),Math.max(...vertices.map(v=>v.z))]};});
 const inside=(x,z)=>Math.abs(x)<=12&&Math.abs(z)<=12,navigation=createApprovedNavigation({inside,obstacles,assets:{},docks:[]});
 const envelope={radius:1.5,height:2,bounds:{min:[-1,0,-1],max:[1,2,1]},slices:[{min:[-.5,0,-.6],max:[.5,1,.6]},{min:[-1,1,-1],max:[1,2,1]}]};
 for(let i=0;i<300;i++){
  const p={x:random()*26-13,y:random(),z:random()*26-13},yaw=random()*Math.PI*2;
  const expected=rect(p,envelope,yaw).every(v=>inside(v.x,v.z))&&!navigation.physicalObstacles.some(o=>o.max[1]>p.y+.1&&o.min[1]<p.y+envelope.height&&envelope.slices.some(slice=>o.max[1]>p.y+Math.max(.1,slice.min[1])&&o.min[1]<p.y+slice.max[1]&&overlap(rect(p,{bounds:slice},yaw),o.vertices)));
  assert.equal(navigation.fits(p,envelope,yaw),expected,`pose ${i}`);
 }
});

test('pose results are reused only within a route and physical-state validation stays fresh',()=>{
 const navigation=createApprovedNavigation({inside:()=>true,assets:{},docks:[],obstacles:[{min:[81,0,79.9],max:[81.1,3,80.1]}]});
 const from={x:80,y:.36,z:80},to={x:84,y:.36,z:80},actor={id:'unit',home:from,baseYaw:Math.PI/2,envelope:{radius:.25,height:2}};
 assert.deepEqual(navigation.route(actor,from,to),[]);
 navigation.physicalObstacles[0].max[1]=.1;
 assert.ok(navigation.route(actor,from,to).length,'a later route rechecks the changed obstacle');
 navigation.physicalObstacles[0].max[1]=3;
 const trace=[];assert.equal(navigation.fits({x:81,y:.36,z:80},actor.envelope,0,trace),false);assert.equal(trace[0],navigation.physicalObstacles[0]);
});

test('resumable planning agrees with synchronous routes and does not leak its pose cache between steps',()=>{
 const navigation=createApprovedNavigation({inside:()=>true,assets:{},docks:[],obstacles:[{min:[81,0,79.9],max:[81.1,.1,80.1]}]});
 const from={x:80,y:.36,z:80},to={x:84,y:.36,z:80},actor={id:'unit',home:from,baseYaw:Math.PI/2,envelope:{radius:.25,height:2}};
 const expected=navigation.route(actor,from,to),job=navigation.routeSteps(actor,from,to);let result=job.next(),steps=1;
 assert.equal(result.done,false);
 while(!result.done){result=job.next();steps++;}assert.ok(steps>1);assert.deepEqual(result.value,expected);
 const paused=navigation.routeSteps(actor,from,to);paused.next();navigation.physicalObstacles[0].max[1]=3;
 assert.equal(navigation.fits({x:81,y:.36,z:80},actor.envelope),false,'live validation runs outside the paused job cache');paused.return();
});
