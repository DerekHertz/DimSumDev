import * as T from 'three';
import {rolePalette,clothBuilder} from './grove-style.mjs';

export function createGroveHeadwear(role,{runtime='claude'}={}){
 const b=clothBuilder(rolePalette(role,runtime)),{box,orb,cyl,ring,tube,closure}=b,cues=[];
 const band=(y=2.87,h=.09,rx=.49,rz=.40)=>cyl(1,h,'main',[0,y,.10],[rx,1,rz]);
 const brimBand=(y=2.87,rx=.49,rz=.40)=>{const n=ring(1,.025,'accent',[0,y,.10],[rx,rz,1]);n.rotation.x=Math.PI/2;return n;};
 const cap=(height=.22,rx=.53,rz=.44)=>orb(1,'main',[0,2.92,.10],[rx,height,rz]);
 if(role==='orchestrator'){
  cues.push('Chef toque');
  const jiao=runtime==='codex';
  for(let i=0;i<7;i++){const a=i/7*Math.PI*2;const puff=orb(.21,'main',[Math.sin(a)*.33,3.14+(i===3?.05:0),Math.cos(a)*.25+.10],jiao?[.86,1.15,.86]:[1.2,1,1.12]);if(jiao)puff.rotation.z=Math.sin(a)*.3;}
  orb(.26,'main',[0,3.16,.10],[1.3,.8,1]);band(2.98,.14);brimBand(2.91);closure([0,2.98,.53]);
  // Small sculpted eyebrows are resting personality cues, independent of task state.
  for(const x of[-.27,.27])tube([[x-.08,2.70,.52],[x,2.72+(jiao&&x>0?.035:0),.55],[x+.08,2.70,.52]],jiao?.014:.02,'ink');
  if(jiao)for(const x of[-.065,0,.065])orb(.07,'cream',[x,2.84,.49],[.4,1.35,.3]);
 }else if(role==='product'||role==='architect'){
  cues.push('Round spectacles');
  for(const x of[-.26,.26])ring(.172,.018,'ink',[x,2.55,.61]);
  tube([[-.087,2.55,.61],[0,2.57,.64],[.087,2.55,.61]],.013,'ink');
  for(const side of[-1,1])tube([[side*.43,2.55,.59],[side*.58,2.56,.22]],.012,'ink');
  if(role==='architect'){
   cues.push('Ear pencil');const pencil=cyl(.025,.46,'wood',[.59,2.86,.16]);pencil.rotation.z=-.38;
   const tip=b.mesh(new T.ConeGeometry(.026,.08,10),'ink',[.69,3.105,.16]);tip.rotation.z=-.38;
   box([.08,.04,.04],'accent',[.54,2.72,.17]);
  }
 }else if(role==='developer'){
  cues.push('Padded headphones');
  tube([[-.69,2.56,.02],[-.66,2.89,.02],[-.38,3.04,.02],[0,3.08,.02],[.38,3.04,.02],[.66,2.89,.02],[.69,2.56,.02]],.055,'main');
  for(const x of[-.70,.70]){orb(.19,'accent',[x,2.60,.04],[.50,1.08,1]);orb(.17,'main',[x*1.10,2.60,.04],[.33,1,.95]);}
  // A forward seal remains visible from the normal garden camera.
  closure([-.74,2.59,.21]);
 }else if(role==='scout'){
  cues.push('Forehead goggles');band(2.87,.085);brimBand();
  for(const x of[-.23,.23]){const rim=ring(.166,.035,'wood',[x,2.92,.46],[1,.78,1]);rim.rotation.x=-.35;const glass=orb(.143,'lens',[x,2.92,.47],[1,.76,.12]);glass.rotation.x=-.35;}
  tube([[-.065,2.92,.47],[0,2.94,.49],[.065,2.92,.47]],.016,'bamboo');
 }else if(role==='runner'||role==='herald'){
  cues.push(role==='runner'?'Tied headband':'Folded headband');band(2.83,role==='runner'?.095:.065);brimBand(2.85);
  if(role==='runner')for(const sign of[-1,1]){const tail=box([.20,.075,.025],'main',[-.55,2.80+sign*.025,.10+sign*.04]);tail.rotation.z=sign*.4;}
  else{cues.push('Tucked paper slip');const slip=box([.12,.24,.025],'cream',[-.49,2.94,.35]);slip.rotation.z=-.2;for(let i=0;i<3;i++)box([.065,.008,.009],'wood',[-.49,2.88+i*.05,.368]);}
  closure([.35,2.84,.45]);
 }else if(role==='qa'){
  cues.push('Woven douli');
  const cone=b.mesh(new T.ConeGeometry(.90,.27,48,1,true),'straw',[0,3.01,.10]);
  cone.scale.z=.84;
  for(let i=0;i<5;i++){const r=.20+i*.17,y=3.145-r/.90*.27;const weave=ring(r,.009,'wood',[0,y,.10],[1,.84,1]);weave.rotation.x=Math.PI/2;}
  for(let i=0;i<20;i++){const a=i/20*Math.PI*2;tube([[Math.sin(a)*.12,3.11,Math.cos(a)*.10+.10],[Math.sin(a)*.90,2.875,Math.cos(a)*.756+.10]],.007,'wood');}
  brimBand(2.875,.90,.756);band(3.095,.065,.25,.21);closure([0,3.10,.34]);
 }else if(role==='security'){
  cues.push('Short-brim cap');cap(.18);band(2.85,.11);brimBand(2.88);
  orb(1,'accent',[0,2.79,.51],[.50,.035,.28]);closure([0,2.86,.54]);
 }else if(role==='designer'){
  cues.push('Tilted beret');const crown=cap(.19,.70,.54);crown.rotation.z=-.15;band(2.85,.07);brimBand(2.86);orb(.035,'main',[.11,3.10,.01]);closure([.32,2.92,.48]);
 }
 return b.finish('Role headwear · '+role,{headwearRole:role,runtime,cues});
}
