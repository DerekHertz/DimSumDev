import {useEffect,useRef,useState} from 'react';
import {useFrame,useThree} from '@react-three/fiber';
import * as THREE from 'three';
import {createMeshyWorld} from './world.mjs';
import {createMeshyActors} from './actors.mjs';
import {liveActorsFromSnapshot} from '../../review/live-actors.mjs';
import {agentFor,cardFor,pickedCard} from '../../overlay/proximity-card.mjs';
import {TABLE,seatSpots,seated,tableMeeting} from './meeting-table.mjs';
import {sameResident,boundAgentKey} from '../../shell/resident-inventory.mjs';

// Native R3F scene. App remains the sole owner of live state, actions and panels.
export function MeshyDen({snapshot,placements,frontier,tally,selected,onSelect,onOpenTally,stage,onReady,onNearby,onScenePresentations,picked=null,onPick,zoneView=null,onZoneClick=null,onLoadState,bindings=null,onOpenMeeting=null}){
 const [den,setDen]=useState(null);
 const live=useRef(null),inputs=useRef({});inputs.current={snapshot,placements,frontier,tally,selected,onSelect,onOpenTally,onNearby,onScenePresentations,picked,onPick,zoneView,onZoneClick,onLoadState,bindings,onOpenMeeting};
 const {scene,gl,camera,size}=useThree();
 useEffect(()=>{
  const abort=new AbortController();let mounted=true,world=null;
  inputs.current.onLoadState?.({status:'loading',message:'Opening the forest garden…'});
  createMeshyWorld(gl,{signal:abort.signal,onProgress:message=>inputs.current.onLoadState?.({status:'loading',message})}).then(d=>{
   world=d;if(!mounted){d.dispose();return;}
   const agents=createMeshyActors(d),media=matchMedia('(prefers-reduced-motion: reduce)');
   // den-mvp/64: a gold ring round the table while a meeting's brief waits on the user.
   const glow=new THREE.Mesh(new THREE.TorusGeometry(2.8,.06,8,72),new THREE.MeshBasicMaterial({color:'#f8bd40',transparent:true,opacity:.9}));
   glow.name='Brief waiting';glow.rotation.x=Math.PI/2;glow.scale.set(1,.68,1);glow.position.set(TABLE.x,.35,TABLE.z);glow.visible=false;d.world.add(glow);
   live.current={den:d,agents,media,anchored:new Set(),proximity:0,meeting:null,susan:d.world.getObjectByName('Lazy susan'),glow};setDen(d);stage.tallyAnchor=d.tallyAnchor;onReady(d);
   inputs.current.onLoadState?.({status:'ready',message:'The forest garden is ready.'});
  }).catch(error=>{if(mounted&&error.name!=='AbortError'){console.error('Den scene',error);inputs.current.onLoadState?.({status:'error',message:'The garden models could not load. Reload to retry.'});}});
  return()=>{mounted=false;abort.abort();onReady(null);inputs.current.onScenePresentations?.([]);stage.meetingAnchors?.clear();stage.toolAnchors?.clear();live.current?.agents.dispose();live.current=null;world?.dispose();stage.anchors.clear();};
 },[gl,stage,onReady]);
 useEffect(()=>{const previous={background:scene.background,fog:scene.fog},media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{const color=media.matches?'#171b20':'#f8f3e8';scene.background=new THREE.Color(color);scene.fog=new THREE.Fog(color,180,300);};apply();media.addEventListener('change',apply);return()=>{media.removeEventListener('change',apply);scene.background=previous.background;scene.fog=previous.fog;};},[scene]);
 useEffect(()=>{if(!den)return;den.setFrontier(frontier||[]);den.setTally(tally?.rods);},[den,frontier,tally]);
 useEffect(()=>{
  const agents=live.current?.agents;if(!agents)return;
  // den-mvp/64: the table's meeting is re-read every second too, so a farewell clears on time.
  const bind=()=>{agents.applyLive(liveActorsFromSnapshot(snapshot,{now:Date.now()}),inputs.current.bindings);const m=tableMeeting(snapshot?.meetings,Date.now());agents.applyMeeting(m);if(live.current)live.current.meeting=m;};bind();const timer=setInterval(bind,1000);return()=>clearInterval(timer);
 },[den,snapshot,bindings]);
 useEffect(()=>{live.current?.agents.setSelected(selected??null);},[den,selected]);
 useEffect(()=>{const visibility=()=>{const agents=live.current?.agents;if(!agents)return;if(!document.hidden){agents.applyLive(liveActorsFromSnapshot(inputs.current.snapshot,{now:Date.now()}),inputs.current.bindings);agents.applyMeeting(tableMeeting(inputs.current.snapshot?.meetings,Date.now()));}agents.setHidden(document.hidden);};document.addEventListener('visibilitychange',visibility);visibility();return()=>document.removeEventListener('visibilitychange',visibility);},[den]);
 useFrame((_,delta)=>{
  const l=live.current;if(!l)return;const dt=Math.min(delta,.1);l.agents.update(dt,l.media.matches);l.elapsed=(l.elapsed||0)+(l.media.matches?0:dt);l.den.ornaments?.update(camera,size.height);l.den.world.updateMatrixWorld(true);
  // Labels float .4 above the head: Bao's crown is 3; a species publishes its own head top (antlers included).
  const labelAt=model=>{const head=l.den.pandaRigs.get(model)?.rig.profile.envelope?.head;return model.localToWorld(new THREE.Vector3(0,(head?.labelTop??head?.top??3)+.4,0));};
  const figures=l.agents.liveFigures(),anchorsNow=new Map();
  const toolAnchors=stage.toolAnchors??(stage.toolAnchors=new Map());toolAnchors.clear();
  for(const [id,a]of l.agents.actors)if(a.panda.model.visible)toolAnchors.set(id,{top:labelAt(a.panda.model),base:a.panda.model.getWorldPosition(new THREE.Vector3())});
  for(const [key,{model,ref,runtime}]of figures){const at=labelAt(model);anchorsNow.set(key,at);if(runtime==='claude')anchorsNow.set(ref,at);}
  for(const key of l.anchored)if(!anchorsNow.has(key)){stage.anchors.delete(key);l.anchored.delete(key);}
  for(const [key,at]of anchorsNow){stage.anchors.set(key,at);l.anchored.add(key);}
  for(const [ref,basket]of l.den.frontier)stage.anchors.set(ref,basket.localToWorld(new THREE.Vector3(0,.6,0)));
  const anchors=stage.meetingAnchors??(stage.meetingAnchors=new Map());anchors.clear();
  if(l.meeting)for(const [role,model]of l.agents.seatModels())anchors.set(role,labelAt(model));
  // The lazy susan turns toward whoever is speaking; with reduced motion it stays put.
  const speaker=seated(l.meeting)?l.meeting.seats.findIndex(s=>s.role===l.meeting.live?.role):-1;
  if(l.susan&&!l.media.matches&&speaker>=0){const spot=seatSpots(l.meeting.seats.length)[speaker],target=Math.atan2(spot.x-TABLE.x,spot.z-TABLE.z);let d=target-l.susan.rotation.y;d=Math.atan2(Math.sin(d),Math.cos(d));l.susan.rotation.y+=d*Math.min(1,dt*1.5);}
  l.glow.visible=l.meeting?.state==='briefed'||l.meeting?.state==='paused';
  l.proximity+=dt;if(l.proximity<.1)return;l.proximity=0;
  inputs.current.onScenePresentations?.(l.agents.presentationRows());
  let card=null;const walking=!!stage.explorer?.active,pick=walking?null:inputs.current.picked;
  if(walking||pick!=null){
   const snap=inputs.current.snapshot,boundRefs=new Set([...l.agents.actors.values()].filter(a=>a.live).map(a=>boundAgentKey(a.live)));
   const pandas=[...l.agents.actors].filter(([,a])=>a.panda.model.visible).map(([id,a])=>{
    const identity={role:a.role,runtime:a.runtime,projectId:a.live?.projectId,agentId:a.live?.agentId,ref:a.live?.ref};
    const position=a.panda.model.getWorldPosition(new THREE.Vector3()),agent=agentFor(identity,snap?.agents,boundRefs);
    const placement=a.live?(snap?.placements||[]).filter(row=>row.ref===a.live.ref&&sameResident({...row,role:row.role||a.role},identity)).reduce((last,row)=>!last||Date.parse(row.lastEventAt)>Date.parse(last.lastEventAt)?row:last,null):null;
    return {id,name:a.name,...identity,dispatchable:!a.concept,team:a.team,position:{x:position.x,z:position.z},ref:a.live?.ref,state:a.live?.state||'resident',presentation:a.presentation,tool:placement?.tool??null,agent};
   });
   const camera=walking?stage.explorer.camera:null;
   card=camera?cardFor(pandas,snap?.approvals||[],{x:camera.position.x,z:camera.position.z,yaw:camera.rotation.y}):pickedCard(pandas,snap?.approvals||[],pick);
  }
  l.agents.hold(card?.id??null);if(card)delete card.distance;inputs.current.onNearby?.(card);
 });
 const hit=e=>{
  for(let object=e.object;object;object=object.parent){
   const actor=object.userData.actorKey||object.userData.workspaceRole,open=inputs.current.onOpenMeeting,m=live.current?.meeting;
   // den-mvp/64: during a meeting a seated panda opens its take, and Bao or the table opens the meeting.
   const seat=actor&&live.current?.agents.seatOf(actor);
   if(open&&m&&!stage.explorer?.active&&(seat||actor==='orchestrator'||object.userData.denInteraction?.id==='center')){e.stopPropagation();open(m.id,seat?.role??null);return;}
   if(actor&&!stage.explorer?.active&&inputs.current.onPick){e.stopPropagation();inputs.current.onPick(actor);return;}
   const local=object.userData.denInteraction;
   if(local){e.stopPropagation();inputs.current.onZoneClick?.(local.id);return;}
   const ref=object.userData.ticketRef;if(ref){e.stopPropagation();inputs.current.onSelect?.(ref);return;}
   if(object.userData.tallyAbacus){e.stopPropagation();stage.tallyHit=true;inputs.current.onOpenTally?.();return;}
  }
 };
 return <>
  <hemisphereLight args={['#fff1d8','#8fa47b',1.65]}/>
  <directionalLight position={[-35,60,30]} intensity={2.5} color='#ffebc3' castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-80} shadow-camera-right={70} shadow-camera-top={75} shadow-camera-bottom={-70} shadow-camera-far={200} shadow-normalBias={.06}/>
  <directionalLight position={[12,10,-8]} intensity={.65} color="#d6e9ff"/>
  {den?<primitive object={den.world} dispose={null} onClick={hit}/>:null}
 </>;
}
