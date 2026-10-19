import * as T from 'three';
import {GROVE_TOOLS,createGroveTool} from './grove-tools.mjs';

export const ROLE_TOOLS=Object.freeze({...GROVE_TOOLS,debugger:'Inspection lantern','release-manager':'Festival mallet','knowledge-keeper':'Archive book','docs-writer':'Writing brush','stem-cub':'Bamboo sprout'});

/** Small authored tools follow a paw socket; wardrobe still supplies each role's attire. */
export function createRoleTool(role,options={}){
 if(GROVE_TOOLS[role])return createGroveTool(role,options);
 if(!ROLE_TOOLS[role])throw Error('Unknown role tool: '+role);
 const root=new T.Group();root.name=ROLE_TOOLS[role];root.userData={roleId:role,tool:ROLE_TOOLS[role]};
 const mats=Object.fromEntries(Object.entries({wood:'#bc9366',cream:'#fff2d7',jade:'#61876c',gold:'#d6b260',ink:'#35534b',coral:'#cc8d79',blue:'#89aebc',lilac:'#b4a1bf'}).map(([id,color])=>[id,new T.MeshStandardMaterial({color,roughness:.82})]));
 const mesh=(g,c,p=[0,0,0])=>{const m=new T.Mesh(g,mats[c]);m.position.fromArray(p);m.castShadow=true;root.add(m);return m;};
 const box=(s,c,p)=>mesh(new T.BoxGeometry(...s),c,p);
 const orb=(r,c,p)=>mesh(new T.SphereGeometry(r,12,8),c,p);
 const rod=(h,r,c,p)=>mesh(new T.CylinderGeometry(r,r,h,12),c,p);
 const ring=(r,c,p)=>mesh(new T.TorusGeometry(r,.022,6,24),c,p);
 if(['product','developer','knowledge-keeper'].includes(role)){
  box([.38,.46,.075],role==='developer'?'blue':role==='product'?'coral':'jade',[0,-.12,.04]);box([.30,.37,.012],'cream',[0,-.12,.085]);
  if(role==='developer'){box([.26,.29,.014],'ink',[0,-.11,.098]);orb(.018,'gold',[0,-.30,.10]);}else for(let i=0;i<3;i++)box([.22-i*.035,.012,.008],'wood',[0,-.06-i*.07,.096]);
 }else if(role==='architect'){
  box([.12,.65,.055],'wood',[0,-.18,.04]);for(let i=0;i<7;i++)box([i%2?.055:.08,.012,.012],'ink',[.015,.08-i*.065,.076]);
 }else if(role==='qa'){
  ring(.17,'gold',[0,.05,.05]);rod(.32,.035,'wood',[0,-.27,.05]);
 }else if(role==='security'){
  ring(.10,'gold',[0,.10,.04]);rod(.37,.032,'gold',[0,-.13,.04]);for(const y of[-.22,-.29])box([.13,.04,.045],'gold',[.045,y,.04]);
 }else if(role==='designer'){
  const p=orb(.23,'wood',[0,-.11,.04]);p.scale.set(1.1,.8,.18);for(let i=0;i<4;i++){const a=i/4*Math.PI*2;orb(.043,['coral','blue','jade','lilac'][i],[Math.cos(a)*.13,-.11+Math.sin(a)*.10,.09]);}
 }else if(role==='scout'){
  const dial=rod(.055,.17,'gold',[0,-.04,.04]);dial.rotation.x=Math.PI/2;const face=rod(.012,.145,'cream',[0,-.04,.075]);face.rotation.x=Math.PI/2;const needle=box([.025,.22,.02],'coral',[0,-.04,.09]);needle.rotation.z=.42;
 }else if(role==='debugger'){
  box([.24,.28,.19],'cream',[0,-.13,.04]);for(const y of[-.29,.03])box([.29,.045,.23],'wood',[0,y,.04]);ring(.10,'gold',[0,.13,.04]);
 }else if(role==='herald'){
  box([.31,.38,.025],'cream',[0,-.11,.04]);for(const y of[-.32,.10]){const roll=rod(.38,.055,'wood',[0,y,.04]);roll.rotation.z=Math.PI/2;}for(let i=0;i<3;i++)box([.22,.011,.01],'jade',[0,-.01-i*.07,.06]);
 }else if(role==='docs-writer'){
  rod(.62,.024,'wood',[0,-.12,.04]);const nib=orb(.055,'ink',[0,-.46,.04]);nib.scale.set(.5,1.7,.5);
 }else if(role==='release-manager'){
  rod(.53,.028,'wood',[0,-.11,.04]);orb(.11,'coral',[0,.18,.04]);
 }else if(role==='stem-cub'){
  rod(.42,.025,'jade',[0,-.15,.04]);for(const side of[-1,1]){const leaf=orb(.12,'jade',[side*.09,.05,.04]);leaf.scale.set(.36,1,.25);leaf.rotation.z=-side*.65;}
 }else{
  for(let i=0;i<3;i++)box([.15,.26,.045],['jade','coral','gold'][i],[(i-1)*.13,-.08,.03+i*.015]);
 }
 const used=new Set();root.traverse(n=>{if(n.material)used.add(n.material);});for(const m of Object.values(mats))if(!used.has(m))m.dispose();
 return root;
}
