import { LIVE_ROLES } from '../../review/live-actors.mjs';
import { residentKey, sameResident } from '../../shell/resident-inventory.mjs';
import {seated} from './meeting-table.mjs';
export const canonicalRole = id => ({release:'release-manager',keeper:'knowledge-keeper',writer:'docs-writer',cub:'stem-cub'}[id] || id);
export const RESIDENT_HEIGHT = 2.04;
export const PLAYER_EYE_HEIGHT = 1.82;
export const WALK_START = Object.freeze({x:0,z:42,yaw:0,pitch:.04,groundY:.36,eyeHeight:PLAYER_EYE_HEIGHT});
export const NAVIGATION_TARGETS = Object.freeze({pass:[-30.5,2,-32],center:[0,2,-4],steamers:[-30.5,1,24],'front-of-house':[30.5,1,24],front:[30.5,1,24],tea:[30.5,1,-32],pantry:[30.5,1,-32],library:[0,1,24],gate:[0,1,42],training:[0,1,39.8],festival:[-65,1,-4],dining:[46,1,-4],pavilion:[-46,1,-4],games:[46,1,-4]});
export function actorBindings(live=[],previous=new Map(),{meeting=null}={}) {
  const next=new Map();
  for(const runtime of ['claude','codex'])for(const role of LIVE_ROLES){
    const key=residentKey(role,runtime),rows=live.filter(a=>sameResident(a,{role,runtime,projectId:a.projectId})),old=previous.get(key);
    const atTable=runtime==='claude'&&role!=='orchestrator'&&seated(meeting)&&meeting.seats.some(s=>s.role===role);
    const work=atTable?rows.filter(a=>a.ref!==meeting.ref):rows;
    const keepGuest=atTable&&previous.has(`meeting:${role}`);
    const candidates=work.length?work:keepGuest?[]:rows;
    const primary=candidates.find(a=>a.ref===old?.ref&&a.agentId===old?.agentId&&sameResident(a,old))||candidates[0];
    if(primary)next.set(key,primary);
    for(const row of rows)if(row!==primary){
      let visitor=atTable&&row.ref===meeting.ref&&!next.has(`meeting:${role}`)?`meeting:${role}`:`${key}#${row.ref}`;
      if(row.ref===primary?.ref||next.has(visitor))visitor+=`@${row.agentId}`;next.set(visitor,row);
    }
  }
  return next;
}
export function meshMotion(time,index=0,reduced=false){
  if(reduced)return {lift:0,roll:0,turn:0};
  const phase=time*.85+index*.63;
  return {lift:.007*(1+Math.sin(phase)),roll:.008*Math.sin(phase*.7),turn:.024*Math.sin(phase*.35)};
}

export const MESHY_TEAM_LABELS = Object.freeze([
 {id:'pass',text:'The Pass',x:-30.5,y:7.5,z:-32},
 {id:'steamers',text:'Steamers',x:-30.5,y:7.5,z:24},
 {id:'front-of-house',text:'Front of House',x:30.5,y:7.5,z:24},
 {id:'tea',text:'Tea & Pantry',x:30.5,y:7.5,z:-32},
 {id:'library',text:'Library',x:0,y:6.8,z:24},
]);

const WALK_PLACES = [
 ...MESHY_TEAM_LABELS.map(p => ({ label: p.text, x: p.x, z: p.z })),
 ...[['gate', 'Entrance'], ['training', 'Practice garden'], ['dining', 'Dining garden'], ['pavilion', 'Tea pavilion'], ['festival', 'Festival lawn']].map(([id, label]) => ({ label, x: NAVIGATION_TARGETS[id][0], z: NAVIGATION_TARGETS[id][2] })),
];
export function walkLocation({ x, z }) {
 let label = 'Garden paths', distance = 6;
 for (const place of WALK_PLACES) {
  const next = Math.hypot(x - place.x, z - place.z);
  if (next < distance) { label = place.label; distance = next; }
 }
 return label;
}
