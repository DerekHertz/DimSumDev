import {RESIDENTS} from '../../shell/resident-inventory.mjs';
import {GROUND} from './plush/assembly.mjs';

// Local homes use the active garden's asset transforms, not the old review site plan.
export function residentHomes(garden){
 const homes=new Map();
 const put=(role,team,point,yaw=0)=>homes.set(role,{team,point,yaw});
 for(const team of ['pass','pantry','front'])for(const spec of garden.assets[team].residents)put(spec.id,team,[spec.position[0],spec.position[1],2.8],spec.yaw);
 for(const [role,spec]of Object.entries(garden.assets.steamers.residents))put(role,'steamers',[spec.position[0],spec.position[1],2.8],spec.yaw);
 put('runner','steamers',[0,.41,2.8]);
 // New charter roles occupy a second row beside their team's landing. Keep the
 // middle approach and the existing four runtime perches in each pavilion clear.
 put('release-manager','pass',[-3.05,0,5.8]);
 put('code-reviewer','pantry',[-3.05,0,5.8]);put('sre','pantry',[3.05,0,5.8]);
 put('technical-writer','front',[3.05,0,5.8]);
 put('debugger','steamers',[0,.41,1.1],-.10);put('knowledge-keeper','library',[-1.1,.43,2.6],.18);
 put('docs-writer','library',[2,.43,2.45],-.25);put('stem-cub',null,[0,GROUND,25.6]);
 return RESIDENTS.map(resident=>{
  if(resident.role==='orchestrator')return {...resident,teamId:null,position:[resident.runtime==='claude'?-1.75:1.75,GROUND+.03,-.6],yaw:0};
  const home=homes.get(resident.role),point=[...home.point];
  if(resident.dispatchable)point[0]+=resident.runtime==='claude'?-.82:.82;
  const position=home.team?garden.worldPoint(home.team,point).toArray():point;
  return {...resident,teamId:home.team,position,yaw:home.yaw+(garden.assets[home.team]?.root.rotation.y||0)};
 });
}
