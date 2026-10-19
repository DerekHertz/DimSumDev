import * as T from 'three';
import {createRoleHeadwear} from './role-headwear.mjs';
import {box,cyl,orb,line} from './garden.mjs';
import {GROVE_ROLES,rolePalette,clothBuilder} from './grove-style.mjs';

// Shared fits and fixed role IDs keep the resident, visitor and cached portrait in agreement.
export const ROLE_OUTFITS = Object.freeze([
  ['orchestrator','vest','#674698','chef-toque'], ['product','vest','#674698','spectacles'],
  ['architect','vest','#674698','spectacles-and-pencil'], ['developer','vest','#2759a2','headphones'],
  ['scout','vest','#2759a2','goggles'], ['runner','vest','#2759a2','tied-headband'], ['debugger','scarf','#637c8d',null],
  ['qa','vest','#006e54','woven-douli'], ['security','vest','#326a2d','brim-cap'],
  ['designer','vest','#00658b','beret'], ['herald','vest','#00658b','folded-headband'],
  ['release-manager','vest','#b97a53','festival-band'], ['knowledge-keeper','vest','#487a80','archive-hat'],
  ['docs-writer','scarf','#59678b',null], ['stem-cub','vest','#9aafc6','nightcap'],
].map(([id,clothing,color,headwear])=>Object.freeze({id,clothing,color,headwear})));

function recolor(clone,color,flat=false) {
  clone.traverse(node=>{
    if(!node.isMesh)return;
    if(node.parent?.name==='Security · local frog closure')return;
    const recolorMaterial=source=>{
      const copy=source.clone();
      if(flat){copy.map=null;copy.color.set(color);}
      else if(!source.map){copy.color.set(color);}
      else{
        const tint=new T.Color(color);copy.color.set('#ffffff');
        copy.onBeforeCompile=shader=>{
          shader.uniforms.wardrobeTint={value:tint};
          shader.fragmentShader=shader.fragmentShader
            .replace('#include <common>','#include <common>\nuniform vec3 wardrobeTint;')
            .replace('#include <map_fragment>','#include <map_fragment>\nfloat wardrobeLuma=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));\ndiffuseColor.rgb=wardrobeTint*mix(.65,1.25,wardrobeLuma);');
        };
        copy.customProgramCacheKey=()=> 'role-outfit-fabric';
      }
      return copy;
    };
    node.material=Array.isArray(node.material)?node.material.map(recolorMaterial):recolorMaterial(node.material);
  });
}

function groveDetails(role,palette,runtime){
  const b=clothBuilder(palette),{box,orb,ring,tube,closure}=b;
  const cuffs=[];
  const folded=role==='orchestrator'&&runtime==='codex';
  // The open jacket leaves the approved belly and the original fur visible.
  tube([[-.68,2.10,.27],[-.50,2.06,.57],[0,1.99,.81],[.50,2.06,.57],[.68,2.10,.27]],.085,'main');
  tube([[-.58,2.13,.34],[-.36,2.06,.68],[.06,1.99,.85],[.49,2.08,.56]],.055,'accent');
  for(const sign of[-1,1]){
    tube([[sign*.91,1.30,.04],[sign*.76,1.30,.64],[sign*.50,1.30,.91],[sign*.16,1.30,1.04]],.022,'main');
    const tail=box([folded?.15:.19,.32,.045],sign<0?'main':'accent',[sign*.12,1.85,.91]);tail.rotation.z=sign*(folded?.45:.30);
    const sleeve=clothBuilder(palette);
    const cuff=sleeve.ring(.28,.040,'main',[sign*1.10,1.45,-.035],[1.2,.75,1]);cuff.rotation.y=Math.PI/2;cuff.rotation.z=-sign*.82;
    const edge=sleeve.ring(.28,.016,'accent',[sign*1.13,1.415,-.035],[1.2,.75,1]);edge.rotation.y=Math.PI/2;edge.rotation.z=-sign*.82;
    cuffs.push(sleeve.finish('Grove cuff · '+(sign>0?'L':'R'),{attachBone:'Elbow_'+(sign>0?'L':'R')}));
  }
  closure([0,1.99,.93]);
  if(role==='orchestrator'&&runtime==='claude')orb(.15,'main',[.46,1.68,.91],[1,1,.15]);
  else box([.26,.25,.035],'main',[.46,1.70,.91]);
  box([.24,.025,.04],'accent',[.46,1.82,.935]);
  for(let i=0;i<2;i++){
    const pen=box([.018,.18,.018],role==='orchestrator'&&runtime==='codex'?'cream':'wood',[.40+i*.07,1.88,.94]);pen.rotation.z=i*.1;
    box([.025,.025,.02],'bamboo',[-.50,1.63+i*.17,.93]);
  }
  if(role==='orchestrator'&&runtime==='codex')box([.12,.24,.02],'cream',[.50,1.89,.92]).rotation.z=-.12;
  const result=b.finish('Grove collar, cuffs and pocket',{groveRole:role,runtime});result.add(...cuffs);return result;
}

function roleAccessories(group,id) {
  const material=color=>new T.MeshStandardMaterial({color,roughness:.82});
  const gold=material('#c3a367'),ink=material('#39494b');
  if(['product','knowledge-keeper'].includes(id)){
    for(const x of[-.255,.255]){const frame=new T.Mesh(new T.TorusGeometry(.165,.014,6,32),gold);frame.position.set(x,2.555,.588);group.add(frame);}
    line(group,[[-.085,2.56,.60],[0,2.575,.62],[.085,2.56,.60]],.012,gold);
  }
  if(id==='architect')cyl(group,.018,.32,gold,[.60,2.72,.13],8).rotation.z=-.24;
  if(id==='orchestrator')orb(group,.06,ink,[.64,2.6,.05],[.5,1,1]);
  if(id==='herald'){line(group,[[.63,2.57,.1],[.62,2.36,.44],[.38,2.28,.62]],.018,ink);orb(group,.045,ink,[.38,2.28,.62]);}
  if(id==='debugger'){box(group,[.12,.17,.06],ink,[.52,2.04,.66]);box(group,[.075,.07,.015],gold,[.52,2.06,.70]);}
  if(id==='stem-cub')orb(group,.05,gold,[.35,1.95,.73],[1,.75,.2]);
  const used=new Set();group.traverse(node=>{if(node.isMesh)used.add(node.material);});
  if(!used.has(gold))gold.dispose();if(!used.has(ink))ink.dispose();
}

/** Clone the fitted template, sharing geometry and textures; only tint materials differ. */
export function createRoleOutfit(roleId,{vest,scarf,securityVest,headphones}={}, {runtime='claude'}={}) {
  const spec=ROLE_OUTFITS.find(row=>row.id===roleId);
  if(!spec)throw Error('Unknown role outfit: '+roleId);
  if(!['claude','codex'].includes(runtime))throw Error('Unknown panda runtime: '+runtime);
  const grove=Boolean(GROVE_ROLES[roleId]),palette=grove?rolePalette(roleId,runtime):null;
  const template=spec.clothing==='scarf'?scarf:!grove&&roleId==='security'&&securityVest?securityVest:vest;
  if(!template)throw Error('Missing fitted '+spec.clothing+' template for '+roleId);
  const group=new T.Group();group.name='Role outfit · '+roleId;
  const garment=template.clone(true);recolor(garment,palette?.main||spec.color,spec.clothing==='scarf');
  group.add(garment);
  const headwear=createRoleHeadwear(roleId,{runtime});if(headwear)group.add(headwear);
  if(grove)group.add(groveDetails(roleId,palette,runtime));else roleAccessories(group,roleId);
  group.userData={outfitRole:roleId,clothing:spec.clothing,headwear:spec.headwear,runtime,...(palette?{palette}:{})};
  return group;
}

/** Existing Meshy wardrobe loading creates just these four fitted templates once. */
export function completeRoleOutfits(den) {
  const resident=id=>den.residents.children.find(person=>person.userData.roleId===id);
  const templates={vest:resident('developer')?.getObjectByName('Wardrobe · developer-vest'),
    scarf:resident('qa')?.getObjectByName('Wardrobe · qa-scarf'),
    securityVest:resident('security')?.getObjectByName('Wardrobe · security-vest'),
    headphones:resident('developer')?.getObjectByName('Wardrobe · developer-headphones')};
  const staged=ROLE_OUTFITS.filter(spec=>spec.id!=='runner'||resident('runner')).map(spec=>{
    const person=resident(spec.id);if(!person)throw Error('Missing role resident: '+spec.id);
    return {person,outfit:createRoleOutfit(spec.id,templates,{runtime:person.userData.runtime||'claude'})};
  });
  for(const template of Object.values(templates))template?.removeFromParent();
  for(const{person,outfit}of staged)person.add(outfit);
  den.roleOutfits={loaded:staged.map(({person})=>person.userData.roleId),headwear:staged.filter(({outfit})=>outfit.userData.headwear).map(({person})=>person.userData.roleId)};
  return den.roleOutfits;
}
