import { LIVE_ROLES } from '../../review/live-actors.mjs';
import { residentKey, sameResident } from '../../shell/resident-inventory.mjs';
export const canonicalRole = id => ({release:'release-manager',keeper:'knowledge-keeper',writer:'docs-writer',cub:'stem-cub'}[id] || id);
export const RESIDENT_HEIGHT = 2.04;
export const PLAYER_EYE_HEIGHT = 1.82;
export const WALK_START = Object.freeze({x:0,z:34,yaw:0,pitch:.04,groundY:.26,eyeHeight:PLAYER_EYE_HEIGHT});
export const NAVIGATION_TARGETS = Object.freeze({pass:[0,2,-17.4],center:[0,2,0],steamers:[-20.2,1,-11.9],'front-of-house':[21,1,5],front:[21,1,5],tea:[20.2,1,-11.9],pantry:[20.2,1,-11.9],library:[-21,1,6],gate:[0,1,34],training:[0,1,25.6],festival:[-26,1,20],dining:[-10,1,20.5],pavilion:[10.5,1,20.5],games:[-10,1,20.5]});
export function actorBindings(live=[],previous=new Map()) {
  const next=new Map();
  for(const runtime of ['claude','codex'])for(const role of LIVE_ROLES){
    const key=residentKey(role,runtime),rows=live.filter(a=>sameResident(a,{role,runtime,projectId:a.projectId})),old=previous.get(key);
    const primary=rows.find(a=>a.ref===old?.ref&&a.agentId===old?.agentId&&sameResident(a,old))||rows[0];
    if(!primary)continue;
    next.set(key,primary);
    for(const row of rows)if(row!==primary){let visitor=`${key}#${row.ref}`;if(row.ref===primary.ref||next.has(visitor))visitor+=`@${row.agentId}`;next.set(visitor,row);}
  }
  return next;
}
export function meshMotion(time,index=0,reduced=false){
  if(reduced)return {lift:0,roll:0,turn:0};
  const phase=time*.85+index*.63;
  return {lift:.007*(1+Math.sin(phase)),roll:.008*Math.sin(phase*.7),turn:.024*Math.sin(phase*.35)};
}

export const MESHY_TEAM_LABELS = Object.freeze([
 {id:'pass',text:'The Pass',x:0,y:6.8,z:-17.4},
 {id:'steamers',text:'Steamers',x:-20.2,y:6.8,z:-11.9},
 {id:'front-of-house',text:'Front of House',x:21,y:6.8,z:5},
 {id:'tea',text:'Tea & Pantry',x:20.2,y:6.8,z:-11.9},
 {id:'library',text:'Library',x:-21,y:6.8,z:6},
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
