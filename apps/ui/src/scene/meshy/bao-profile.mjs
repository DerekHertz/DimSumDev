import { BAO_PROFILE } from './panda-rig.mjs';
import { MathUtils } from 'three';

const armAnchors={Shoulder:[1,1.5,.01],Elbow:[1.3,1.3,.06],Wrist:[1.5,1.12,.12],paw:[1.58,1.1,.17]};
const rest=BAO_PROFILE.rest.map(([name,parent,position])=>{
  const [part,side]=name.split('_'),anchor=armAnchors[part];
  return [name,parent,anchor?[anchor[0]*(side==='L'?1:-1),anchor[1],anchor[2]]:position];
});
function weightsFor(position,headOnly=false){
  if(headOnly)return [['Head',1]];
  const {x,y}=position,ax=Math.abs(x),side=x>=0?'L':'R',smooth=MathUtils.smoothstep;
  // A's sleeves attach lower and farther out than the legacy panda's shoulders.
  // Keep the robe's inner edge on its torso; blend along the actual arm, not height.
  const boundary=.65+.16*MathUtils.clamp((1.65-y)/.6,0,1);
  const arm=smooth(ax,boundary,boundary+.35)*smooth(y,.65,.82)*(1-smooth(y,1.7,1.88));
  const core=BAO_PROFILE.weightsFor(position).filter(([name])=>!name.startsWith('Shoulder_')&&!name.startsWith('Elbow_')&&!name.startsWith('Wrist_')&&!name.startsWith('paw_'));
  const total=core.reduce((n,[,w])=>n+w,0),weights=total?core.map(([name,w])=>[name,w/total*(1-arm)]):[['Chest',1-arm]];
  let low='Shoulder',high='Elbow',t=smooth(ax,.84,1.15);
  if(ax>1.15){low='Elbow';high='Wrist';t=smooth(ax,1.15,1.43);}
  if(ax>1.43){low='Wrist';high='paw';t=smooth(ax,1.43,1.52);}
  weights.push([low+'_'+side,arm*(1-t)],[high+'_'+side,arm*t]);
  const top=weights.filter(([,w])=>w>1e-7).sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((n,[,w])=>n+w,0);
  return top.map(([name,w])=>[name,w/sum]);
}

// Selected Meshy A uses the shared named rig and its own gesture handedness.
// This profile belongs only to Bao (Claude orchestrator); Jiao keeps its own appearance.
export const BAO_PRODUCTION = Object.freeze({
  ...BAO_PROFILE, id: 'giant-panda', label: 'Bao · jade sash',
  rest,weightsFor,
  greetingDirection: 1,
  greetingLift: 1.1,greetingElbowLift: .8,
  sit: { drop: .12, hip: 1.3, knee: -.3, splay: .7 },
  envelope: {
    standing: { radius: 1.9, height: 3.2 }, moving: { radius: 1.95, height: 3.2 },
    seated: { radius: 1.9, height: 3.1 }, head: { top: 3.2, labelTop: 3, radius: 1.6 },
  },
});
