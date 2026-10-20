// Pure placement and state mapping for the code-built den, which is the v5 kit's village (den-mvp/25).
// Team positions are the kit's: Steamers [-14,-10], Plating (Front of House) [14,-10], Tea [-14,0], Pantry [14,0].
export const TEAMS = {
  steamers: { index: 0, x: -14, z: -10, yaw: 0, label: 'Steamers' },
  'front-of-house': { index: 1, x: 14, z: -10, yaw: 0, label: 'Front of House' },
  tea: { index: 2, x: -14, z: 0, yaw: 0, label: 'Tea' },
  pantry: { index: 3, x: 14, z: 0, yaw: 0, label: 'Pantry' },
};
export const ROLE_TEAM = {
  orchestrator:'pass', product:'pass', architect:'pass',
  developer:'steamers', scout:'steamers', qa:'tea', security:'pantry', designer:'front-of-house',
};
// The Pass roles stand on the ground beside the Pass counter; Bao is the orchestrator, so nothing perches on him.
export const PADS = {
  product: { x: -4, z: -11, label: 'Library' },
  architect: { x: 4, z: -11, label: 'Drum' },
};
// The kit's abacus at [18,0,10]: the Tally's pill hangs above its sign.
export const TALLY_ANCHOR = { x: 18, y: 3.1, z: 10 };
export const DEN_TARGET = [0, 2.0, 0];
export const TEAM_LABELS = [
  {id:'pass',text:'The Pass',x:0,y:3.6,z:-10},
  ...Object.entries(TEAMS).map(([id,s])=>({id,text:s.label,x:s.x,y:4.6,z:s.z})),
  {id:'library',text:'Library',x:PADS.product.x,y:0.3,z:PADS.product.z},
  {id:'drum',text:'Drum',x:PADS.architect.x,y:0.3,z:PADS.architect.z},
];

export function planPlacements(placements) {
  // Live orchestrator work shows on Bao himself, not as another panda.
  const live=placements.filter(c=>!c.synthetic&&c.role!=='orchestrator'), counts={}, slots={};
  for(const c of live){const s=ROLE_TEAM[c.role]||'cubs';counts[s]=(counts[s]||0)+1;}
  let overflow=0;
  return live.map(c=>{
    const role=c.role,team=ROLE_TEAM[role]||'cubs';
    const key=team==='pass'?role:team,slot=slots[key]||0;slots[key]=slot+1;
    let placement;
    if(PADS[role]) {
      // Slot 0 takes over the resident's spot; later ones split off to alternating sides.
      const side=slot===0?0:(slot%2?1:-1)*Math.ceil(slot/2);
      placement={parent:'world',position:[PADS[role].x+side*0.7,0.03,PADS[role].z],scale:0.34};
    } else if(TEAMS[team]) {
      const n=counts[team],cols=Math.min(4,n),row=Math.floor(slot/cols),col=slot%cols;
      placement={parent:'stall:'+TEAMS[team].index,position:[(col-(cols-1)/2)*0.8,0.21,-0.5-row*0.45],scale:n>4?0.28:0.36};
    } else {
      const i=overflow++;
      placement={parent:'world',position:[-3.0+(i%4)*0.8,0,2.0+Math.floor(i/4)*0.8],scale:0.30};
    }
    return { ...c, team, placement };
  });
}

export function poseFor(state,time=0,reduced=false) {
  const t=reduced?0:time;
  const rest={head:0,root:0,arm:0,elbow:0,wrist:0,sleepiness:0.15};
  if(state==='working')return {...rest,head:0.015*Math.sin(t*2),arm:0.05+0.025*Math.sin(t*4),wrist:0.08*Math.sin(t*4)};
  if(state==='waiting_on_user')return {...rest,arm:0.84,elbow:0.60,wrist:0.10*Math.sin(t*3),sleepiness:0};
  if(state==='blocked')return {...rest,head:0.08,arm:0.27,elbow:0.34,sleepiness:0.32};
  if(state==='done')return {...rest,head:-0.05,root:-0.04,sleepiness:0.23};
  if(state==='failed')return {...rest,head:0.17,root:0.04,sleepiness:0.40};
  if(state==='throttled')return {...rest,head:0.13,sleepiness:0.68};
  return rest;
}
