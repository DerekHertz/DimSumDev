import * as THREE from 'three';
import {CHARACTERS,animateActivity} from '../scene/procedural/restaurant.mjs';
import {isDenPositionBlocked} from '../scene/procedural/walk.mjs';
import {compactPanda} from '../scene/procedural/compact.mjs';
import {createTraditionalGear} from './traditional-props.mjs';
import {compactReviewGear} from './compact-gear.mjs';
import {ROLE_HOMES,REVIEW_PLACES,REVIEW_OBSTACLES,BAO_HOME,BAO_SCALE,groundY} from './site-plan.mjs';
import {VILLAGE_PATHS} from '../scene/expansion/base-assets.mjs';
import {LIVE_ROLES} from './live-actors.mjs';

const RADIUS=0.65,STEP=0.5,BOUNDS=[-26,26,-26,26],GARDEN_REACH=27;
const inside=([x,z])=>x>=BOUNDS[0]&&x<=BOUNDS[1]&&z>=BOUNDS[2]&&z<=BOUNDS[3]&&Math.hypot(x,z)<=GARDEN_REACH;
const clear=(p,obstacles)=>inside(p)&&!isDenPositionBlocked(...p,obstacles,RADIUS+0.02);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function lineClear(a,b,obstacles){
  if(!clear(a,obstacles)||!clear(b,obstacles))return false;
  for(const o of obstacles){
    let x=a[0]-o.x,z=a[1]-o.z,dx=b[0]-a[0],dz=b[1]-a[1];
    if(o.type==='box'){
      const c=Math.cos(o.rotation||0),s=Math.sin(o.rotation||0);
      [x,z]=[c*x-s*z,s*x+c*z];[dx,dz]=[c*dx-s*dz,s*dx+c*dz];
      let low=0,high=1;
      for(const [p,d,h]of [[x,dx,o.halfX+RADIUS+0.015],[z,dz,o.halfZ+RADIUS+0.015]]){
        if(Math.abs(d)<1e-9){if(Math.abs(p)>h){high=-1;break;}}
        else{const t1=(-h-p)/d,t2=(h-p)/d;low=Math.max(low,Math.min(t1,t2));high=Math.min(high,Math.max(t1,t2));}
      }
      if(low<=high)return false;
    }else if(o.type==='circle'||o.type==='ellipse'){
      const rx=(o.type==='circle'?o.radius:o.rx)+RADIUS+0.015,rz=(o.type==='circle'?o.radius:o.rz)+RADIUS+0.015;
      x/=rx;z/=rz;dx/=rx;dz/=rz;
      const t=Math.max(0,Math.min(1,-(x*dx+z*dz)/(dx*dx+dz*dz||1)));
      if((x+dx*t)**2+(z+dz*t)**2<=1)return false;
    }
  }
  return true;
}
function nearestClear(p,obstacles,connected=false){
  const candidates=[];
  for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++){
    const q=[Math.round(p[0]/STEP)*STEP+x*STEP,Math.round(p[1]/STEP)*STEP+z*STEP];
    if(clear(q,obstacles)&&(!connected||lineClear(p,q,obstacles)))candidates.push(q);
  }
  candidates.sort((a,b)=>distance(a,p)-distance(b,p));return candidates[0];
}
// den-mvp/25: the village's promenades and station approaches. Walking off them costs half as much again, so a panda
// follows the paths between stations and cuts across the lawn only when that is much shorter.
const PATH_WIDTH=1.1,OFF_PATH=1.5;
const segmentDistance=(x,z,[a,b])=>{
  const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
  return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);
};
const onPath=(x,z)=>VILLAGE_PATHS.some(seg=>segmentDistance(x,z,seg)<=PATH_WIDTH);
export const pathCost=(a,b)=>{
  const length=distance(a,b),n=Math.max(1,Math.ceil(length/0.5));let cost=0;
  for(let i=0;i<n;i++){const t=(i+0.5)/n;cost+=length/n*(onPath(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t)?1:OFF_PATH);}
  return cost;
};
class Heap{
  constructor(){this.items=[];}
  get size(){return this.items.length;}
  push(item){const a=this.items;a.push(item);let i=a.length-1;while(i>0){const p=(i-1)>>1;if(a[p].f<=a[i].f)break;[a[p],a[i]]=[a[i],a[p]];i=p;}}
  pop(){
    const a=this.items,top=a[0],last=a.pop();
    if(a.length){a[0]=last;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<a.length&&a[l].f<a[m].f)m=l;if(r<a.length&&a[r].f<a[m].f)m=r;if(m===i)break;[a[m],a[i]]=[a[i],a[m]];i=m;}}
    return top;
  }
}
export function findReviewPath(start,end,obstacles){
  if(!clear(start,obstacles)||!clear(end,obstacles))return null;
  // A short, open line is walked straight; a long one follows the paths when they are not much longer.
  const direct=lineClear(start,end,obstacles);
  if(direct&&distance(start,end)<=5)return [start,end];
  const first=nearestClear(start,obstacles,true),last=nearestClear(end,obstacles,true);
  if(!first||!last||!lineClear(start,first,obstacles)||!lineClear(last,end,obstacles))return direct?[start,end]:null;
  const key=p=>p.join(','),initial={p:first,g:0,f:distance(first,last),parent:null};
  const open=new Heap(),best=new Map([[key(first),0]]);open.push(initial);let finish;
  while(open.size){
    const current=open.pop();
    if(current.g>best.get(key(current.p)))continue;
    if(distance(current.p,last)<0.01){finish=current;break;}
    for(const dx of [-STEP,0,STEP])for(const dz of [-STEP,0,STEP]){
      if(!dx&&!dz)continue;const p=[current.p[0]+dx,current.p[1]+dz];
      if(!inside(p))continue;
      const g=current.g+pathCost(current.p,p);
      if(g>=(best.get(key(p))??Infinity)||!lineClear(current.p,p,obstacles))continue;
      best.set(key(p),g);open.push({p,g,f:g+distance(p,last),parent:current});
    }
  }
  if(!finish)return direct?[start,end]:null;
  const path=[end];for(let n=finish;n;n=n.parent)path.unshift(n.p);path.unshift(start);
  // Shorten only where the shortcut is no dearer than the stretch it replaces.
  const smooth=[start];let i=0;
  while(i<path.length-1){
    let next=path.length-1;
    for(;next>i+1;next--){
      if(!lineClear(path[i],path[next],obstacles))continue;
      let along=0;for(let k=i;k<next;k++)along+=pathCost(path[k],path[k+1]);
      if(pathCost(path[i],path[next])<=along+1e-6)break;
    }
    smooth.push(path[next]);i=next;
  }
  return smooth;
}

const FAVORITES=['meeting','tea','games','training','training','training','tea','training','games','rest','rest','games','rest','tea'];
const PLACES=REVIEW_PLACES;
const RUNNING=new Set(['received','working','needs-you','complete']);
export function createReviewAgents(den,createBao,{direction='traveler',onChange=()=>{}}={}){
  const root=new THREE.Group();root.name='Interactive role pandas';den.world.add(root);
  const actors=new Map(),owned=[],gears=[],events=[];let time=0,eventId=0,lastSnapshot=-1;
  // Posts and lantern poles are a few centimetres wide: only the player's body stops at them (site-plan.mjs `thin`).
  const obstacles=[...den.obstacles,...REVIEW_OBSTACLES].filter(o=>!o.thin);
  function emit(){onChange(snapshot());lastSnapshot=time;}
  function log(a,text){events.push({id:++eventId,role:a.role,name:a.name,text,time});if(events.length>30)events.shift();emit();}
  function snapshot(){return {simulated:true,actors:[...actors.values()].map(a=>({role:a.role,name:a.name,station:a.station,state:a.state,activity:a.activity,bubble:a.bubble,task:a.task,reply:a.reply,concept:a.concept,stationary:a.stationary})),events:events.slice(-8)};}
  function route(a,destination,target,arrival='leisure'){
    if(PLACES[destination]){
      const reserved=[...actors.values()].filter(other=>other!==a&&other.destination===destination);
      const spots=[...PLACES[destination].spots].sort((x,y)=>distance(x,target)-distance(y,target));
      target=spots.find(spot=>!reserved.some(other=>distance(spot,other.target)<1.35));
      if(!target){a.age=0;return false;}
    }
    const start=[a.panda.model.position.x,a.panda.model.position.z],end=nearestClear(target,obstacles);
    const path=end&&findReviewPath(start,end,obstacles);
    if(!path){a.path=[];a.state='blocked';a.activity='Path blocked';a.bubble='This path is blocked. Try another place.';log(a,'could not find a clear path.');return false;}
    a.path=path.slice(1);a.target=end;a.destination=destination;a.arrival=arrival;a.state='walking';a.age=0;
    a.activity=arrival==='working'?`Heading to ${a.station}`:`Walking to ${PLACES[destination]?.name.toLowerCase()||'you'}`;
    return true;
  }
  for(const [i,[role,name,station,,,concept]]of CHARACTERS.entries()){
    const panda=role==='orchestrator'?den.hero:createBao(THREE,{detail:'low'});
    if(panda!==den.hero){owned.push(panda);compactPanda(THREE,panda);}
    root.attach(panda.model);panda.model.visible=true;panda.model.scale.setScalar(role==='orchestrator'?BAO_SCALE:role==='stem-cub'?0.36:0.43);
    const occupied=[...actors.values()].map(a=>({type:'circle',x:a.home[0],z:a.home[1],radius:0.65}));
    const home=role==='orchestrator'?BAO_HOME:nearestClear(ROLE_HOMES[role],[...obstacles,...occupied]);panda.model.position.set(home[0],groundY(home[0],home[1])+(role==='orchestrator'?0.03:0.04),home[1]);panda.model.rotation.set(0,0,0);
    panda.model.userData.reviewAgent=role;panda.model.userData.reviewPart=`${name} · body`;panda.model.userData.actorKey=role;
    gears.push(compactReviewGear(createTraditionalGear(panda,role,direction)));
    const a={role,name,station,stationary:role==='orchestrator',concept:!!concept,index:i,panda,home,favorite:FAVORITES[i],state:'leisure',activity:role==='orchestrator'?'Hosting the den':'Getting ready for a break',bubble:'',reply:'',task:'',age:0,wave:0,path:[],destination:null};actors.set(role,a);
    if(!a.stationary){const place=PLACES[a.favorite];route(a,a.favorite,place.spots[i%place.spots.length]);}
  }
  function sendTask(role,text){
    const a=actors.get(role),task=String(text||'').trim().slice(0,600);
    if(!a||!task||isBusy(a))return false;
    a.path=[];a.task=task;a.reply='';a.state='received';a.activity='Message received';a.bubble=a.stationary?'Got your message. Let’s work on it here.':'Got your message. I’m heading to my station.';a.age=0;log(a,'received your preview task.');return true;
  }
  function isBusy(a){return !!a.live||RUNNING.has(a.state)||a.state==='walking'&&a.arrival==='working';}
  function wave(role){const a=actors.get(role);if(!a)return;a.wave=2.5;a.bubble=`Hello! I’m ${a.name}.`;log(a,'waves back to you.');}
  function talk(role){const a=actors.get(role);if(!a)return;a.wave=1.5;if(!isBusy(a))a.bubble=`Find me at ${a.station}, or join me for ${PLACES[a.favorite].name.toLowerCase()}.`;log(a,'is ready to chat.');}
  function comeHere(role,point){
    const a=actors.get(role);if(!a||a.stationary||isBusy(a))return false;
    if(!route(a,'greeting',point,'greeting'))return false;
    a.bubble='On my way!';log(a,'is coming over to greet you.');return true;
  }
  function answer(role){const a=actors.get(role);if(a?.state!=='needs-you')return false;a.state='working';a.activity='Finishing your request';a.bubble='Thanks! Finishing the preview.';a.age=0;a.answered=true;log(a,'received your answer.');return true;}
  function resume(role){
    const a=actors.get(role);if(!a||isBusy(a)&&a.state!=='complete')return false;
    if(a.stationary){a.state='leisure';a.activity='Hosting the den';a.task='';a.reply='';a.bubble='I’m here when you need me.';a.answered=false;emit();return true;}
    for(const id of [a.favorite,...Object.keys(PLACES).filter(id=>id!==a.favorite)]){
      const p=PLACES[id];if(!route(a,id,p.spots[a.index%p.spots.length]))continue;
      a.task='';a.reply='';a.bubble='Back to my break.';a.answered=false;log(a,'is returning to leisure.');return true;
    }
    a.bubble='The leisure spots are busy. I’ll wait here with you.';emit();return false;
  }
  function gather(){let seat=0;for(const role of ['product','architect','designer','qa']){const a=actors.get(role);if(isBusy(a))continue;if(route(a,'meeting',PLACES.meeting.spots[seat++]))log(a,'is joining the dim sum table.');}}
  // The panda the user stands with (its card is showing) holds still, so a task can be typed without chasing it.
  // One with a live agent is not held: it goes to its station and stays there anyway.
  let heldActor=null;
  function hold(key=null){heldActor=actors.get(key)??null;}
  function update(dt,paused=false){
    if(paused||dt<=0)return;time+=dt;
    for(const a of actors.values()){
      a.age+=dt;a.wave=Math.max(0,a.wave-dt);const p=a.panda.model,b=a.panda.bones,held=a===heldActor&&!a.live;
      if(a.state==='received'&&a.age>=0.8){a.answered=false;if(a.stationary){a.state='working';a.age=0;a.activity='Inspecting the request';a.bubble='Thinking through your request…';log(a,'is inspecting your request.');}else if(route(a,'station',a.home,'working'))log(a,`is heading to ${a.station}.`);}
      if(a.state==='walking'){
        let budget=held?0:dt*1.65;
        while(a.path.length&&budget>0){
          const next=a.path[0],dx=next[0]-p.position.x,dz=next[1]-p.position.z,d=Math.hypot(dx,dz),step=Math.min(budget,d,0.1);
          const nx=p.position.x+(d?dx/d*step:0),nz=p.position.z+(d?dz/d*step:0);
          const others=[...actors.values()].filter(other=>other!==a);
          const collision=others.some(other=>{
            const q=other.panda.model.position,before=Math.hypot(p.position.x-q.x,p.position.z-q.z),after=Math.hypot(nx-q.x,nz-q.z);
            return after<1.22&&after<before-1e-6;
          });
          if(collision){
            let bypassed=false;
            if(time>=(a.retryAt||0)){
              a.retryAt=time+0.6;
              const neighbors=others.map(other=>({type:'circle',x:other.panda.model.position.x,z:other.panda.model.position.z,radius:0.565}));
              const bypass=findReviewPath([p.position.x,p.position.z],a.target,[...obstacles,...neighbors]);
              if(bypass){a.path=bypass.slice(1);bypassed=true;}
            }
            if(bypassed)break;
            // Give the planner room when two pandas meet between grid cells.
            // A small outward step preserves clearance instead of pushing through the other panda.
            const nearest=others.reduce((best,o)=>Math.hypot(o.panda.model.position.x-p.position.x,o.panda.model.position.z-p.position.z)<Math.hypot(best.panda.model.position.x-p.position.x,best.panda.model.position.z-p.position.z)?o:best,others[0]);
            const q=nearest.panda.model.position,before=Math.hypot(p.position.x-q.x,p.position.z-q.z),angle=Math.atan2(p.position.z-q.z,p.position.x-q.x);
            for(const offset of [0,0.5,-0.5,1,-1,1.5,-1.5]){
              const x=p.position.x+Math.cos(angle+offset)*step,z=p.position.z+Math.sin(angle+offset)*step;
              if(clear([x,z],obstacles)&&Math.hypot(x-q.x,z-q.z)>before+0.005&&!others.some(o=>Math.hypot(x-o.panda.model.position.x,z-o.panda.model.position.z)<1.22)){
                const path=findReviewPath([x,z],a.target,obstacles);
                if(!path)continue;
                p.position.x=x;p.position.z=z;p.rotation.y=Math.atan2(x-nx,z-nz);a.path=path.slice(1);a.retryAt=0;break;
              }
            }
            break;
          }
          if(d>0){p.position.x+=dx/d*step;p.position.z+=dz/d*step;p.rotation.y=Math.atan2(dx,dz);}budget-=step;
          if(d<=step+1e-6)a.path.shift();
        }
        if(!a.path.length&&!held){a.state=a.arrival;a.age=0;
          a.activity=a.state==='working'?'Inspecting the request':a.state==='greeting'?'Here with you':PLACES[a.destination].name;
          const center=PLACES[a.destination]?.center;if(center)p.rotation.y=Math.atan2(center[0]-p.position.x,center[1]-p.position.z);
          a.bubble=a.state==='working'?'Thinking through your request…':a.state==='greeting'?'Hello! What shall we work on?':'';
          log(a,a.state==='working'?'is inspecting your request.':`arrived: ${a.activity.toLowerCase()}.`);
        }
      }else if(a.state==='working'&&!a.live){
        if(!a.answered&&a.age>=3.5){a.state='needs-you';a.age=0;a.activity='Needs your answer';a.bubble='Should I prepare a first draft for you to review?';log(a,'has a question for you.');}
        else if(a.answered&&a.age>=2){a.state='complete';a.age=0;a.activity='Waiting for you';a.reply=`Preview complete: “${a.task}”. ${a.station} has a first draft ready for your review. This is a simulated response.`;a.bubble='Your first draft is ready!';log(a,'finished the preview and is waiting for you.');}
        else if(a.age>1.5)a.bubble=a.answered?'Preparing the first draft…':'Inspecting recipe notes…';
      }
      if(!a.stationary&&!held&&a.state==='leisure'&&a.age>16+a.index*0.7){
        const ids=Object.keys(PLACES),id=ids[(ids.indexOf(a.destination)+1+a.index%2)%ids.length],place=PLACES[id];
        route(a,id,place.spots[a.index%place.spots.length]);
      }
      if(a.live)syncLive(a);
      // The same plush rig waddles; its gear stays on its head and paw bones.
      for(const name of ['Hip_L','Hip_R','Shoulder_L','Shoulder_R','Elbow_L','Elbow_R','Wrist_L','Wrist_R','Head'])b[name].rotation.set(0,0,0);
      p.position.y=groundY(p.position.x,p.position.z)+(a.stationary?0.03:0.04);
      if(a.state==='walking'&&!held){
        const phase=time*7+a.index,step=Math.sin(phase);b.Hip_L.rotation.x=step*0.13;b.Hip_R.rotation.x=-step*0.13;
        b.Shoulder_L.rotation.x=-step*0.08;b.Shoulder_R.rotation.x=step*0.08;p.position.y+=0.025*(1-Math.cos(phase*2));b.Torso.rotation.z=step*0.025;
      }else{
        b.Torso.rotation.z=0;animateActivity(a.panda,a.role,time);
        if(a.destination==='meeting'&&a.state==='leisure'){b.Elbow_R.rotation.x=0.1+0.15*Math.sin(time+a.index);b.Head.rotation.x=0.08;}
        if(a.destination==='training'&&a.state==='leisure')b.Shoulder_R.rotation.x=0.2*Math.sin(time*2+a.index);
      }
      if(a.wave>0){b.Shoulder_L.rotation.z=0.85;b.Elbow_L.rotation.z=0.55;b.Wrist_L.rotation.z=0.2*Math.sin(time*8);}
      p.updateMatrixWorld(true);
    }
    if(time-lastSnapshot>0.4)emit();
  }
  // den-layout/03: real agents drive the pandas. applyLive replaces the whole live set (the output of
  // liveActorsFromSnapshot). A bound panda walks to its station and shows its agent's state, bubble and ticket;
  // a second agent of a role gets a split-off panda; a role that leaves the set returns to idle wandering.
  const splits=new Map();let splitIndex=CHARACTERS.length;
  function addSplit(role){
    const base=actors.get(role);if(!base)return null;
    const occupied=[...actors.values()].map(a=>({type:'circle',x:a.home[0],z:a.home[1],radius:0.65}));
    const home=nearestClear(ROLE_HOMES[role],[...obstacles,...occupied]);if(!home)return null;
    const panda=createBao(THREE,{detail:'low'});compactPanda(THREE,panda);owned.push(panda);
    root.attach(panda.model);panda.model.visible=true;panda.model.scale.setScalar(0.43);panda.model.position.set(home[0],groundY(home[0],home[1])+0.04,home[1]);panda.model.rotation.set(0,0,0);
    panda.model.userData.reviewAgent=role;panda.model.userData.reviewPart=`${base.name} (split) · body`;
    const gear=compactReviewGear(createTraditionalGear(panda,role,direction));gears.push(gear);
    return {role,name:`${base.name} (split)`,station:base.station,stationary:false,concept:false,index:splitIndex++,panda,home,favorite:base.favorite,state:'working',activity:'Working',bubble:'',reply:'',task:'',age:0,wave:0,path:[],destination:'station',gear};
  }
  function removeSplit(key){
    const a=actors.get(key);if(!a)return;
    actors.delete(key);splits.delete(key);if(heldActor===a)heldActor=null;
    a.gear.dispose();gears.splice(gears.indexOf(a.gear),1);
    a.panda.model.removeFromParent();a.panda.model.traverse(o=>o.geometry?.dispose());a.panda.dispose();owned.splice(owned.indexOf(a.panda),1);
  }
  // The role panda is the den's only live representation of its agent: it carries the ticket ref (a click on any
  // part resolves to it), glows when that ticket is selected, and is what the chips anchor to.
  let selectedRef=null;
  function glow(a,on){
    const m=a.panda.materials?.cream;if(!m)return;
    m.emissive?.set(on?'#08676b':'#000000');m.emissiveIntensity=on?0.12:0;
  }
  function setSelected(ref=null){selectedRef=ref;for(const a of actors.values())glow(a,!!a.live&&a.live.ref===ref);}
  function liveFigures(){
    const out=new Map();
    for(const a of actors.values())if(a.live)out.set(a.live.ref,{model:a.panda.model,panda:a.panda});
    return out;
  }
  function syncLive(a){
    const l=a.live;a.task=l.task;a.bubble=l.bubble;a.reply='';
    a.panda.model.userData.ticketRef=l.ref;glow(a,l.ref===selectedRef);
    if(a.state==='walking')return;
    a.state=l.state;a.activity=l.activity;
    if(!a.stationary&&a.age>=3&&distance([a.panda.model.position.x,a.panda.model.position.z],a.home)>0.9){a.age=0;route(a,'station',a.home,'working');}
  }
  function bind(a,l){
    const fresh=!a.live;a.live=l;a.reply='';a.answered=false;
    if(fresh&&!a.stationary)route(a,'station',a.home,'working');
    syncLive(a);
  }
  function unbind(a){
    delete a.panda.model.userData.ticketRef;glow(a,false);
    a.live=null;a.state='leisure';a.activity=a.stationary?'Hosting the den':'Getting ready for a break';a.task='';a.reply='';a.bubble='';a.answered=false;a.age=0;
    if(a.stationary)return;
    for(const id of [a.favorite,...Object.keys(PLACES).filter(id=>id!==a.favorite)]){
      const p=PLACES[id];if(route(a,id,p.spots[a.index%p.spots.length]))return;
    }
  }
  function applyLive(liveActors=[]){
    const primary=new Map(),wanted=new Map();
    for(const l of liveActors){
      if(!LIVE_ROLES.includes(l.role)||!actors.has(l.role)||(l.runtime!==undefined&&l.runtime!=='claude'))continue;
      if(!l.split&&!primary.has(l.role))primary.set(l.role,l);else wanted.set(`${l.role}#${l.ref}`,l);
    }
    for(const role of LIVE_ROLES){
      const a=actors.get(role),l=primary.get(role);
      if(!a)continue;
      if(l)bind(a,l);else if(a.live)unbind(a);
    }
    for(const key of [...splits.keys()])if(!wanted.has(key))removeSplit(key);
    for(const [key,l] of wanted){
      let a=splits.get(key);
      if(!a){a=addSplit(l.role);if(!a)continue;a.panda.model.userData.actorKey=key;actors.set(key,a);splits.set(key,a);}
      a.live=l;syncLive(a);
    }
    emit();
  }
  function dispose(){
    for(const g of gears)g.dispose();
    for(const p of owned){p.model.traverse(o=>o.geometry?.dispose());p.dispose();}
    // Bao is the den's own; leave him attached for its cleanup.
    for(const a of actors.values())if(!owned.includes(a.panda))den.world.attach(a.panda.model);
    root.removeFromParent();
  }
  emit();return {root,actors,obstacles,snapshot,update,wave,talk,sendTask,answer,resume,comeHere,gather,applyLive,hold,liveFigures,setSelected,dispose};
}
