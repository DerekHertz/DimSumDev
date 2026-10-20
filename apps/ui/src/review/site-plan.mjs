import {ZONES} from '../scene/expansion/integration/zone-contract.mjs';
import {VILLAGE_POSITIONS} from '../scene/expansion/base-assets.mjs';
// Shared geography of the den, which is the v5 kit's assembled village (den-mvp/25): visible structures, clearance and
// panda destinations agree. Positions are the kit's own (VILLAGE_POSITIONS); the offsets below are read from its builders.
export const GARDEN_RADIUS=28;
export const WAVE_ONE_ZONES=ZONES.filter(z=>['repair','archive','pond'].includes(z.id));
export const REVIEW_SKIES={morning:'#dce7d9',lantern:'#22373e',garden:'#cfdfd6'};

const P=VILLAGE_POSITIONS;
const at=(id,dx=0,dz=0)=>[P[id][0]+dx,P[id][2]+dz];

// The four working teams (the kit's `team(kind)`: a 4.1 x 3 pavilion open to the back and the sides, a prep counter
// along its front). `roles` stand behind the counter, at `homes`.
export const REVIEW_TEAMS=[
  {id:'steamers',asset:'steamers',label:'Steamers',x:P.steamers[0],z:P.steamers[2],yaw:0,roles:['developer','scout']},
  {id:'front-of-house',asset:'front',label:'Front of House',x:P.front[0],z:P.front[2],yaw:0,roles:['designer','herald']},
  {id:'tea',asset:'tea',label:'Tea & Pantry',x:P.tea[0],z:P.tea[2],yaw:0,roles:['qa']},
  {id:'pantry',asset:'pantry',label:'Tea & Pantry',x:P.pantry[0],z:P.pantry[2],yaw:0,roles:['security']},
];
export const PASS={x:P.bao[0],z:P.bao[2]};
export const BAO_HOME=[PASS.x,PASS.z-0.6];
export const BAO_SCALE=1.14;
export const LANTERN_POSTS=[[-7.9,0,4],[7.9,0,4],[-7.9,0,15],[7.9,0,15],[-3,0,24],[3,0,24]];
// The leisure places of the village. Each is a kit asset with room to stand around it.
const place=(id,name,center,offsets)=>[id,{name,center,spots:offsets.map(([dx,dz])=>[center[0]+dx,center[1]+dz])}];
export const REVIEW_PLACES=Object.fromEntries([
  place('tea','Tea break',at('retreat'),[[-2.3,.6],[2.3,.6],[0,2.6],[0,-2.4]]),
  place('games','Playing mahjong',at('mahjong'),[[2.9,0],[0,-2.9],[0,2.9],[2.05,2.05]]),
  place('training','Staff practice',at('skills'),[[-3.1,.9],[2.6,2.6],[-1.4,2.6],[3.1,.9]]),
  place('meeting','Round table',at('meeting'),[[1.35,2.34],[2.7,0],[1.35,-2.34],[-1.35,-2.34],[-2.7,0],[-1.35,2.34]]),
  place('rest','Resting nook',at('rest'),[[-1.1,.9],[1.1,.9],[.5,2.9]]),
]);
export const ROLE_HOMES={
  orchestrator:BAO_HOME,
  product:[-4,-11],architect:[4,-11],
  developer:at('steamers',-.8,-.5),scout:at('steamers',.8,-.5),debugger:[-16.5,-8.2],
  qa:at('tea',0,-.5),security:at('pantry',-.6,-.5),
  designer:at('front',-.8,-.5),herald:at('front',.8,-.5),
  'release-manager':[18,7.6],'knowledge-keeper':[8.2,-12.6],'docs-writer':[12,-11.4],'stem-cub':at('rest',.2,.6),
};
// Ground the feet stand on: the kit's raised platforms and round pads.
const FLOORS=[
  ...REVIEW_TEAMS.map(s=>({x:s.x,z:s.z,halfX:1.95,halfZ:1.4,y:.21})),
  {x:P.rest[0],z:P.rest[2],halfX:1.7,halfZ:1.2,y:.21},
];
const PADS=[
  {x:P.bao[0],z:P.bao[2],r:3.2,y:.13},{x:P.meeting[0],z:P.meeting[2],r:2.8,y:.13},
  {x:P.retreat[0],z:P.retreat[2],r:1.85,y:.13},{x:P.mahjong[0],z:P.mahjong[2],r:2.1,y:.13},{x:P.skills[0],z:P.skills[2],r:2,y:.13},
];
export function groundY(x,z){
  for(const f of FLOORS)if(Math.abs(x-f.x)<=f.halfX&&Math.abs(z-f.z)<=f.halfZ)return f.y;
  for(const p of PADS)if(Math.hypot(x-p.x,z-p.z)<=p.r)return p.y;
  return 0;
}

// Walk solids. `thin` ones (posts, lantern poles) are a few centimetres wide: the player's body stops at them, a panda's
// planning radius would wall the pavilions in, so the role pandas' planner leaves them out.
const box=(x,z,halfX,halfZ,extra)=>({type:'box',x,z,halfX,halfZ,rotation:0,...extra});
const circle=(x,z,radius,extra)=>({type:'circle',x,z,radius,...extra});
// The frontier baskets' grid (den-scene.mjs) beside the ticket baskets.
const FRONTIER_BOX=[-19,-7.7];
const teamSolids=REVIEW_TEAMS.flatMap(({x,z})=>{
  const out=[box(x,z+.65,1.5,.42),
    ...[-1.6,1.6].flatMap(dx=>[-1.08,1.08].map(dz=>circle(x+dx,z+dz,.15,{thin:true})))];
  return out;
});
const pantryShelf=box(P.pantry[0]+1,P.pantry[2]-.83,.6,.3);
const bambooRing=Array.from({length:28},(_,i)=>{const a=Math.PI*.53+i*Math.PI*.94/27;return [Math.sin(a)*26,Math.cos(a)*26];}).filter(([,z])=>z<4)
  .map(([x,z])=>circle(x,z,.35));
export const REVIEW_OBSTACLES=[
  ...teamSolids,pantryShelf,
  // The Pass: the counter and its sign, the two planters, Bao at his post.
  box(PASS.x,PASS.z+2,1.95,.5),...[-2.5,2.5].map(dx=>circle(PASS.x+dx,PASS.z,.5)),circle(BAO_HOME[0],BAO_HOME[1],.9),
  ...[-1.6,1.6].map(dx=>circle(PASS.x+dx,PASS.z+1.75,.12,{thin:true})),
  // The round table pavilion: the table, six stools, its posts.
  circle(...at('meeting'),1.45),
  ...Array.from({length:6},(_,i)=>circle(P.meeting[0]+Math.sin(i*Math.PI/3)*2,P.meeting[2]+Math.cos(i*Math.PI/3)*2,.36)),
  ...[-2.1,2.1].flatMap(dx=>[-1.73,1.73].map(dz=>circle(P.meeting[0]+dx,P.meeting[2]+dz,.12,{thin:true}))),
  // Leisure: the tea table and its bamboo, the mahjong table and stools, the practice garden's baskets.
  circle(...at('retreat'),.8),circle(...at('retreat',-1.1,-.8),.3),circle(...at('retreat',1.1,-.8),.3),
  box(...at('mahjong'),.85,.85),...[[0,1.5],[0,-1.5],[-1.5,0],[1.5,0]].map(([dx,dz])=>circle(...at('mahjong',dx,dz),.36)),
  circle(-12.8,19,.8),
  box(...at('skills',0,.25),1.5,.35),circle(...at('skills',-1.7,.6),.3),
  box(...at('rest',0,-.88),1.4,.1),
  // Props: the order rail, ticket baskets, handoff trolley, tally, attention kit, library, study, connector, gate.
  box(FRONTIER_BOX[0],FRONTIER_BOX[1],1.5,.75),box(...at('rail'),1.4,.15),box(...at('baskets'),1,.5),box(...at('trolley'),.75,.43),
  box(...at('abacus'),1.15,.6),box(...at('request',.5,.35),.35,.28),circle(...at('request',-.3,0),.2,{thin:true}),
  box(...at('library'),1.9,1.4),box(...at('study',0,-.25),1,.45),circle(...at('study',-1.5,-.35),.35),box(...at('connector'),1.4,1.1),
  ...[[-1.2,.4],[0,-.4],[1.2,.3]].map(([dx,dz])=>circle(...at('grove',dx,dz),.3)),
  ...[-1.7,1.7].map(dx=>circle(...at('gate',dx,0),.25,{thin:true})),
  ...LANTERN_POSTS.map(([x,,z])=>circle(x,z,.2,{thin:true})),
  ...bambooRing,
];
