import { BAO_PROFILE } from './panda-rig.mjs';
import { MathUtils } from 'three';

const armAnchors={Shoulder:[.8,1.65,.01],Elbow:[1.3,1.3,.06],Wrist:[1.5,1.12,.12],paw:[1.58,1.1,.17]};
const rest=BAO_PROFILE.rest.map(([name,parent,position])=>{
  const [part,side]=name.split('_'),anchor=armAnchors[part];
  return [name,parent,anchor?[anchor[0]*(side==='L'?1:-1),anchor[1],anchor[2]]:position];
});
const torso=[['Pelvis',.65],['Spine',1.3],['Chest',1.87],['Neck',2.08],['Head',2.25]];
function weightsFor(position,headOnly=false){
  if(headOnly)return [['Head',1]];
  const {x,y,z}=position,ax=Math.abs(x),side=x>=0?'L':'R',smooth=MathUtils.smoothstep;
  // A's sleeves attach lower and farther out than the legacy panda's shoulders.
  // Keep the robe's inner edge on its torso; blend along the actual arm, not height.
  const boundary=.5+.16*MathUtils.clamp((1.65-y)/.6,0,1);
  // The underarm slopes down toward the paw. A horizontal lower band pulls
  // the robe hem/pouch into the wave; a narrow side band stretches the sleeve.
  const lower=.95-.5*(ax-.8);
  const arm=smooth(ax,boundary,boundary+.7)*smooth(y,lower,lower+.3)*(1-smooth(y,1.7,1.88));
  // A's broad thighs need a wider inner blend than the old panda. Keep the
  // soles rigid, while the upper leg and robe ease toward the pelvis for sitting.
  const leg=(1-arm)*(1-smooth(y,.35,.85))*MathUtils.lerp(1,smooth(ax,.1,.6),smooth(y,.17,.5));
  const core=1-arm-leg,weights=new Map();
  const add=(name,w)=>{if(w>1e-7)weights.set(name,(weights.get(name)||0)+w);};
  let lowTorso=torso[0],highTorso=lowTorso;
  for(let i=0;i<torso.length-1;i++)if(y>=torso[i][1]){lowTorso=torso[i];highTorso=torso[i+1];}
  if(y>=torso.at(-1)[1])lowTorso=highTorso=torso.at(-1);
  const blend=lowTorso===highTorso?0:smooth(y,lowTorso[1],highTorso[1]);
  add(lowTorso[0],core*(1-blend));add(highTorso[0],core*blend);
  let low='Shoulder',high='Elbow',t=smooth(ax,.84,1.15);
  if(ax>1.15){low='Elbow';high='Wrist';t=smooth(ax,1.15,1.43);}
  if(ax>1.43){low='Wrist';high='paw';t=smooth(ax,1.43,1.52);}
  add(low+'_'+side,arm*(1-t));add(high+'_'+side,arm*t);
  if(y>.32){
    const t=smooth(y,.32,.59);add('Knee_'+side,leg*(1-t));add('Hip_'+side,leg*t);
  }else{
    const t=smooth(y,.17,.32),toe=(1-t)*smooth(z,.15,.32);
    add('Knee_'+side,leg*t);add('Ankle_'+side,leg*(1-t-toe));add('Toe_'+side,leg*toe);
  }
  const top=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((n,[,w])=>n+w,0);
  return top.map(([name,w])=>[name,w/sum]);
}

// Selected Meshy A uses the shared named rig and its own gesture handedness.
// This profile belongs only to Bao (Claude orchestrator); Jiao keeps its own appearance.
export const BAO_PRODUCTION = Object.freeze({
  ...BAO_PROFILE, id: 'giant-panda', label: 'Bao · jade sash',
  rest,weightsFor,
  arms: { drop: .65, restInReducedMotion: true },
  greetingDirection: 1,
  greetingLift: 1.3,greetingElbowLift: 0,
  sit: { drop: .12, hip: 1.3, knee: -.3, splay: .7 },
  envelope: {
    standing: { radius: 1.9, height: 3.2 }, moving: { radius: 1.95, height: 3.2 },
    seated: { radius: 1.9, height: 3.1 }, head: { top: 3.2, labelTop: 3, radius: 1.6 },
  },
});
