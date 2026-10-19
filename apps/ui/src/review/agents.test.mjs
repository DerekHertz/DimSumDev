import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createBao} from '../scene/procedural/bao.mjs';
import {createDenScene} from '../scene/procedural/den-scene.mjs';
import {canvasDocument} from '../scene/procedural/den-test-helpers.mjs';
import {isDenPositionBlocked} from '../scene/procedural/walk.mjs';
import {createReviewAgents,findReviewPath} from './agents.mjs';
import {createTraditionalGear} from './traditional-props.mjs';
import {compactReviewGear} from './compact-gear.mjs';
import {VILLAGE_PATHS} from '../scene/expansion/base-assets.mjs';
import {REVIEW_TEAMS,ROLE_HOMES,BAO_HOME,BAO_SCALE,REVIEW_PLACES,REVIEW_OBSTACLES} from './site-plan.mjs';

function withAgents(run){
  const previous=globalThis.document;globalThis.document=canvasDocument();
  let den,agents;
  try{den=createDenScene(THREE,createBao);agents=createReviewAgents(den,createBao);run(agents,den);}
  finally{agents?.dispose();den?.dispose();globalThis.document=previous;}
}

test('fourteen distinct role pandas stand at distinct homes in the village',()=>{
  withAgents((agents,den)=>{
    assert.equal(agents.actors.size,14);assert.equal(new Set([...agents.actors.values()].map(a=>a.panda)).size,14);
    assert.equal(new Set([...agents.actors.values()].map(a=>a.home.join(','))).size,14);
    assert.equal(den.pandas.length,1,'the village brings no placeholder pandas: Bao only');
  });
});

test('routes go around furniture and refuse unreachable destinations',()=>{
  const obstacles=[{type:'box',x:0,z:0,halfX:2,halfZ:2}];
  const route=findReviewPath([-5,0],[5,0],obstacles);
  assert.ok(route.length>2);
  for(let i=1;i<route.length;i++)for(let j=0;j<=20;j++){
    const x=route[i-1][0]+(route[i][0]-route[i-1][0])*j/20,z=route[i-1][1]+(route[i][1]-route[i-1][1])*j/20;
    assert.ok(!isDenPositionBlocked(x,z,obstacles,0.65));
  }
  assert.equal(findReviewPath([-5,0],[0,0],obstacles),null);
});

test('a single role walks to work, waits for a human answer, completes and returns to leisure; pause freezes all state',()=>{
  withAgents((agents)=>{
    const actor=agents.actors.get('developer'),panda=actor.panda,initial=panda.model.position.clone();
    agents.update(2);assert.ok(panda.model.position.distanceTo(initial)>0.1);
    agents.sendTask('developer','Make dumplings');assert.equal(actor.state,'received');
    const received=actor.panda.model.position.clone(),clock=actor.age;agents.update(30,true);
    assert.equal(actor.age,clock);assert.ok(actor.panda.model.position.equals(received));
    for(let i=0;i<1500&&actor.state!=='needs-you';i++)agents.update(0.1);
    assert.equal(actor.state,'needs-you');assert.equal(actor.panda,panda);
    assert.ok(agents.snapshot().events.some(e=>e.text.includes('inspecting')));
    agents.answer('developer');for(let i=0;i<50;i++)agents.update(0.1);
    assert.equal(actor.state,'complete');assert.ok(actor.reply.includes('Make dumplings'));
    agents.resume('developer');assert.equal(actor.state,'walking');
    assert.equal(agents.sendTask('developer','   '),false);
  });
});

test('greetings preserve a running task and gathering sends the existing roles to distinct seats at the round table',()=>{
  withAgents(agents=>{
    const actor=agents.actors.get('qa');agents.sendTask('qa','Taste the tea');agents.wave('qa');
    assert.equal(actor.state,'received');assert.ok(actor.wave>0);
    agents.gather();const seats=[];
    for(const role of ['product','architect','designer']){
      const a=agents.actors.get(role);assert.equal(a.destination,'meeting');assert.equal(a.state,'walking');seats.push(a.target.join(','));
    }
    assert.equal(new Set(seats).size,seats.length);assert.equal(actor.state,'received','busy role keeps its task');
    assert.equal(agents.snapshot().simulated,true);
  });
});

test('every role can circulate and reach its team without crossing a static obstacle',()=>{
  withAgents(agents=>{
    for(let i=0;i<600;i++){
      agents.update(0.1);
      for(const a of agents.actors.values())if(!a.stationary){
        assert.ok(!isDenPositionBlocked(a.panda.model.position.x,a.panda.model.position.z,agents.obstacles,0.65),`${a.role} crossed furniture at ${a.panda.model.position.toArray()}; next ${a.path[0]}`);
        assert.ok(Math.hypot(a.panda.model.position.x,a.panda.model.position.z)<=27,'panda stays inside the garden');
      }
      const actors=[...agents.actors.values()];for(let a=0;a<actors.length;a++)for(let b=a+1;b<actors.length;b++){
        const p=actors[a].panda.model.position,q=actors[b].panda.model.position;
        assert.ok(Math.hypot(p.x-q.x,p.z-q.z)>1.2,`${actors[a].role} overlapped ${actors[b].role}`);
      }
    }
    for(const role of agents.actors.keys())assert.equal(agents.sendTask(role,'Check today’s special'),true);
    for(let i=0;i<1000;i++)agents.update(0.1);
    for(const a of agents.actors.values())assert.equal(a.state,'needs-you',`${a.role} did not reach its team: ${JSON.stringify([...agents.actors.values()].map(a=>({role:a.role,state:a.state,p:[a.panda.model.position.x,a.panda.model.position.z],home:a.home,next:a.path[0]})))}`);
    assert.ok(!agents.snapshot().events.some(e=>e.text.includes('could not find')));
  });
});

test('each team is the kit\'s asset at its mapped position, and its roles work inside it',()=>{
  withAgents((agents,den)=>{
    const expected={steamers:[-14,-10],'front-of-house':[14,-10],tea:[-14,0],pantry:[14,0]};
    REVIEW_TEAMS.forEach((s,i)=>{
      assert.deepEqual([s.x,s.z],expected[s.id]);
      assert.deepEqual(den.stalls[i].position.toArray(),[s.x,0,s.z]);
      assert.equal(den.stalls[i].userData.assetId,s.asset);
      for(const role of s.roles){
        const a=agents.actors.get(role);
        assert.equal(a.team,{steamers:'Steamers','front-of-house':'Front of House',tea:'Tea',pantry:'Pantry'}[s.id]);
        assert.ok(Math.abs(a.home[0]-s.x)<=1.9&&Math.abs(a.home[1]-s.z)<=1.4,`${role} works inside the ${s.id} pavilion, at ${a.home}`);
        assert.ok(!isDenPositionBlocked(a.home[0],a.home[1],agents.obstacles,0.65));
      }
    });
    // The counter is solid; the pavilion is entered from the promenade side.
    for(const s of REVIEW_TEAMS)assert.ok(isDenPositionBlocked(s.x,s.z+0.65,agents.obstacles,0.65),`${s.id}: the counter is solid`);
    for(const [from,role] of [[[-7,-10],'developer'],[[-7,0],'qa'],[[7,0],'security'],[[7,-10],'designer']]){
      const route=findReviewPath(from,agents.actors.get(role).home,agents.obstacles);assert.ok(route,`${role} is reachable from the promenade at ${from}`);
    }
  });
});

test('routes between teams follow the promenades',()=>{
  withAgents(agents=>{
    // Steamers to Plating: the straight line crosses the Pass pavilion; the path is the promenade south of the Pass.
    const route=findReviewPath([-11.5,-10.5],[11.5,-10.5],agents.obstacles);
    assert.ok(route&&route.length>2,'the Pass is walked around');
    let on=0,total=0;
    for(let k=1;k<route.length;k++){
      const [a,b]=[route[k-1],route[k]],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/0.5));
      for(let m=0;m<n;m++){
        const x=a[0]+(b[0]-a[0])*m/n,z=a[1]+(b[1]-a[1])*m/n;total++;
        if(VILLAGE_PATHS.some(([p,q])=>{const dx=q[0]-p[0],dz=q[1]-p[1],t=Math.max(0,Math.min(1,((x-p[0])*dx+(z-p[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(x-p[0]-dx*t,z-p[1]-dz*t)<=1.2;}))on++;
      }
    }
    assert.ok(on/total>=0.7,`${Math.round(on/total*100)}% of the walk is on a path`);
  });
});

test('every leisure place has room for the pandas that go there',()=>{
  withAgents(agents=>{
    for(const [id,place] of Object.entries(REVIEW_PLACES)){
      assert.ok(place.spots.length>=3,id);
      for(const spot of place.spots)assert.ok(!isDenPositionBlocked(spot[0],spot[1],agents.obstacles,0.65),`${id} spot ${spot} is blocked`);
    }
    for(const home of Object.values(ROLE_HOMES))assert.ok(Math.hypot(home[0],home[1])<26.5);
  });
});

test('Bao stays big and at the Pass through greetings, tasks, gatherings and returning to hosting',()=>{
  withAgents(agents=>{
    const bao=agents.actors.get('orchestrator'),position=bao.panda.model.position.clone();assert.equal(bao.panda.model.scale.x,BAO_SCALE);
    assert.deepEqual(position.toArray(),[BAO_HOME[0],0.16,BAO_HOME[1]]);assert.equal(agents.comeHere('orchestrator',[0,10]),false);
    agents.gather();agents.wave('orchestrator');agents.talk('orchestrator');assert.equal(agents.sendTask('orchestrator','Plan tonight’s service'),true);
    for(let i=0;i<70;i++)agents.update(0.1);assert.equal(bao.state,'needs-you');agents.answer('orchestrator');
    for(let i=0;i<30;i++)agents.update(0.1);assert.equal(bao.state,'complete');agents.resume('orchestrator');
    for(let i=0;i<300;i++)agents.update(0.1);assert.ok(bao.panda.model.position.equals(position));assert.equal(bao.panda.model.scale.x,BAO_SCALE);assert.equal(bao.activity,'Hosting the den');
  });
});

test('merging rigid gear preserves its world bounds, bone sockets and editable grip',()=>{
  const p=createBao(THREE,{detail:'low'}),gear=createTraditionalGear(p,'scout','traveler');
  p.model.position.set(5,0,7);p.model.rotation.y=0.8;p.model.scale.setScalar(0.43);p.model.updateMatrixWorld(true);
  const bounds=[gear.hat,gear.prop].map(o=>new THREE.Box3().setFromObject(o));
  const count=o=>{let n=0;o.traverse(x=>{if(x.isMesh)n++;});return n;},before=count(p.model);
  compactReviewGear(gear);p.model.updateMatrixWorld(true);assert.ok(count(p.model)<before);
  for(const [i,o]of [gear.hat,gear.prop].entries()){
    const after=new THREE.Box3().setFromObject(o);assert.ok(after.min.distanceTo(bounds[i].min)<1e-5);assert.ok(after.max.distanceTo(bounds[i].max)<1e-5);
  }
  const first=gear.prop.getWorldPosition(new THREE.Vector3());gear.applyFit({x:0.4});p.model.updateMatrixWorld(true);
  assert.ok(gear.prop.getWorldPosition(new THREE.Vector3()).distanceTo(first)>0.16);assert.equal(gear.prop.parent,p.bones.Wrist_R);
  gear.dispose();p.dispose();
});

test('the den is the village: a finite radius-28 garden, and none of the old den renders',()=>{
  withAgents((agents,den)=>{
    const ground=den.world.children.find(o=>o.geometry?.type==='CylinderGeometry'&&o.geometry.parameters.radiusTop===28);
    assert.ok(ground,'the kit\'s ground, radius 28');
    assert.equal(den.world.userData.assembled,true);
    const names=new Set();den.world.traverse(o=>names.add(o.name));
    for(const gone of ['Dim sum table','Tally abacus','Bamboo clearing','Faceted clearing','Stepping stone','Future restaurant plots','Bamboo leisure gardens','Mountain garden','Restaurant details','Bamboo steamer'])
      assert.ok(!names.has(gone),`${gone} is not rendered`);
    for(const team of ['steamers pavilion','tea pavilion','pantry pavilion','front pavilion'])assert.ok(names.has(team),`${team} is rendered`);
    assert.ok(names.has('Bao’s welcoming Pass')&&names.has('Round-table pavilion'));
    assert.ok(REVIEW_OBSTACLES.length>40);
  });
});
