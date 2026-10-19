import * as T from 'three';
import {clothBuilder} from './grove-style.mjs';

export const GROVE_TOOLS=Object.freeze({orchestrator:'Bamboo fan',product:'Open menu',architect:'Open blueprint',developer:'Test tablet',scout:'Magnifier and ingredient pouch',runner:'Delivery pouch, order slip and bamboo tray',qa:'Porcelain teacup',security:'Pantry seal stamp and inspection slip',designer:'Garnished dim sum plate',herald:'Specials scroll and writing brush'});
export function createGroveTool(role,{runtime='claude'}={}){
 if(!['claude','codex'].includes(runtime))throw Error('Unknown panda runtime: '+runtime);
 const b=clothBuilder({main:'#faf1db',accent:'#527f73',closure:'round-bamboo'}),{box,orb,cyl,ring,tube}=b;
 const lines=(x,y,z,width=.19)=>{for(let i=0;i<3;i++)box([width-i*.025,.008,.008],'wood',[x,y-i*.055,z]);};
 const slip=(x,y,z)=>{box([.20,.30,.02],'cream',[x,y,z]);lines(x,y+.07,z+.014,.13);};
 const pouch=(x,y,z)=>{orb(.15,'cream',[x,y,z],[.86,1,.6]);ring(.052,.013,'wood',[x,y+.12,z]);box([.12,.022,.025],'jade',[x,y+.095,z+.09]);};
 const brush=(x,y,z)=>{cyl(.014,.42,'wood',[x,y,z]);orb(.035,'ink',[x,y-.23,z],[.45,1.7,.45]);};
 if(role==='orchestrator'&&runtime==='claude'){
  const shape=new T.Shape();shape.moveTo(0,-.22);for(let i=0;i<=20;i++){const a=-.75+i/20*1.5;shape.lineTo(Math.sin(a)*.57,-.22+Math.cos(a)*.57);}shape.closePath();
  b.mesh(new T.ExtrudeGeometry(shape,{depth:.018,bevelEnabled:false}),'cream');
  for(let i=0;i<9;i++){const a=-.75+i/8*1.5;tube([[0,-.22,.024],[Math.sin(a)*.56,-.22+Math.cos(a)*.56,.024]],.008,'wood');}
  orb(.025,'bamboo',[0,-.22,.03]);
 }else if(role==='orchestrator'){
  box([.42,.45,.07],'jade',[0,.02,.02]);box([.34,.37,.015],'cream',[0,.02,.065]);
  for(let i=0;i<4;i++)ring(.033,.009,'bamboo',[-.20,-.13+i*.10,.04]);lines(.02,.11,.08,.24);
 }else if(role==='product'){
  for(const sign of[-1,1]){const page=box([.28,.40,.026],'cream',[sign*.14,.04,.02]);page.rotation.y=sign*.20;box([.29,.42,.018],'wood',[sign*.14,.04,-.009]).rotation.y=sign*.20;lines(sign*.14,.12,.065,.19);}
 }else if(role==='architect'){
  box([.58,.35,.022],'cream',[0,.03,.025]);
  for(const x of[-.30,.30])cyl(.045,.39,'cream',[x,.03,.025]);
  for(const y of[-.06,.03,.12])box([.37,.008,.008],'jade',[0,y,.045]);
  for(const x of[-.17,-.05,.07,.17])box([.008,.18,.008],'jade',[x,.03,.045]);
  tube([[-.20,.13,.05],[0,.22,.05],[.20,.13,.05]],.009,'wood');
 }else if(role==='developer'){
  box([.53,.36,.045],'ink',[0,.03,.02]);box([.43,.25,.012],'#46595f',[0,.03,.05]);
  for(let i=0;i<3;i++)box([.027,.016,.008],'cream',[.12+i*.04,.13,.06]);
  lines(0,.07,.06,.21);
 }else if(role==='scout'){
  ring(.15,.025,'bamboo',[-.14,.17,.04]);const lens=orb(.127,'lens',[-.14,.17,.04],[1,1,.09]);
  cyl(.023,.28,'wood',[-.14,-.10,.04]);pouch(.19,-.06,.03);
 }else if(role==='runner'){
  const tray=cyl(.25,.09,'wood',[-.03,-.09,.02],[1,1,.65]);
  for(const y of[-.125,-.07]){const rim=ring(.25,.014,'bamboo',[-.03,y,.02],[1,.65,1]);rim.rotation.x=Math.PI/2;}
  box([.035,.10,.33],'jade',[-.03,-.08,.02]);pouch(-.25,-.05,.01);slip(.23,.15,.03);
 }else if(role==='qa'){
  const cup=b.mesh(new T.LatheGeometry([[.01,-.10],[.075,-.10],[.13,.06],[.14,.09],[.12,.09],[.10,.05],[.065,-.07]].map(p=>new T.Vector2(...p)),32),'cream',[0,.06,.02]);
  cyl(.105,.008,'tea',[0,.12,.02]);const handle=ring(.07,.016,'cream',[.15,.065,.02]);
  for(const x of[-.04,.04])tube([[x,-.01,.137],[x,.04,.15],[x+.025,.08,.15]],.007,'jade');
  const saucer=cyl(.19,.018,'cream',[0,-.06,.02]);
 }else if(role==='security'){
  box([.20,.12,.18],'wood',[-.15,-.04,.02]);cyl(.035,.18,'wood',[-.15,.10,.02]);orb(.065,'wood',[-.15,.21,.02],[.75,1.2,.75]);box([.08,.04,.018],'jade',[-.15,-.035,.12]);slip(.16,.09,.02);
 }else if(role==='designer'){
  cyl(.29,.025,'cream',[0,-.045,.02],[1,1,.74]);orb(.11,'cream',[0,.04,.02],[1,.85,.9]);
  for(let i=0;i<5;i++){const a=i/5*Math.PI*2;tube([[Math.sin(a)*.08,.035,Math.cos(a)*.07+.02],[Math.sin(a)*.055,.105,Math.cos(a)*.04+.02]],.008,'bamboo');}
  for(const x of[-.15,.16])orb(.07,'leaf',[x,-.015,.04],[1,.14,.45]);
  for(let i=0;i<4;i++)orb(.022,'garnish',[(i%2)*.04-.02,.13,Math.floor(i/2)*.03+.01]);
 }else if(role==='herald'){
  box([.32,.43,.016],'cream',[.05,.02,.02]);
  for(const y of[-.21,.25]){const roller=cyl(.026,.39,'wood',[.05,y,.02]);roller.rotation.z=Math.PI/2;}
  lines(.05,.13,.035,.23);brush(-.24,.06,.03);
 }
 const name=role==='orchestrator'&&runtime==='codex'?'Order notebook':GROVE_TOOLS[role];
 const result=b.finish(name,{roleId:role,runtime,tool:name});result.position.set(0,.07,.25);return result;
}
