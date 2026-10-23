import * as T from 'three';

// Signed package 55-56-final-package-r1, approved 2026-10-22. This is a
// presentation filter: callable legacy roles remain available in Team.
export const TEAMS=Object.freeze([
 {id:'pass',name:'The Pass',x:-30.5,z:-32,yaw:0,roles:['product','architect','release-manager']},
 {id:'pantry',name:'Tea & Pantry',x:30.5,z:-32,yaw:0,roles:['code-reviewer','qa','security','sre']},
 {id:'steamers',name:'Steamers',x:-30.5,z:24,yaw:Math.PI,roles:['developer','runner']},
 {id:'front',name:'Front of House',x:30.5,z:24,yaw:Math.PI,roles:['designer','technical-writer']},
]);
export const OFFICE_PLOT=Object.freeze({x:0,z:-32,width:26,depth:17});
export const ACTIVE_ROLES=Object.freeze(['orchestrator',...TEAMS.flatMap(t=>t.roles)]);
export const activeResidents=rows=>rows.filter(r=>ACTIVE_ROLES.includes(r.role));
export const transform=(point,plot)=>new T.Vector3(...point).applyAxisAngle(new T.Vector3(0,1,0),plot.yaw||0).add(new T.Vector3(plot.x,0,plot.z));
export function stationPlacement(team,role,runtime){
 const index=team.roles.indexOf(role),second=runtime==='codex';
 return team.id==='pantry'?{position:[[-12.3,-5.3,5.3,12.3][index],0,second?-6.8:6.8],yaw:second?0:Math.PI}:
  {position:[second?9.6:-9.6,0,team.roles.length===3?(index-1)*7:(index-.5)*9],yaw:second?-Math.PI/2:Math.PI/2};
}
export function workDocks(roster){
 return roster.map(resident=>{
  if(resident.role==='orchestrator')return {...resident,slotId:'work:'+resident.id,staged:true,teamId:'office',position:[resident.runtime==='claude'?-5:5,.36,-15],yaw:0,approach:[[resident.runtime==='claude'?-10:10,.36,-15]]};
  const team=TEAMS.find(t=>t.roles.includes(resident.role)),station=stationPlacement(team,resident.role,resident.runtime);
  const dock=new T.Vector3(0,.36,resident.role==='sre'?1.25:1.1).applyAxisAngle(new T.Vector3(0,1,0),station.yaw).add(new T.Vector3(...station.position));
  // A named internal aisle and dock throat, not arbitrary scene points.
  const approach=team.id==='pantry'?[new T.Vector3(0,.36,dock.z<0?-1.8:1.8),new T.Vector3(dock.x,.36,dock.z<0?-1.8:1.8)]:[new T.Vector3(0,.36,dock.z),new T.Vector3(dock.x<0?-4:4,.36,dock.z)];
  return {...resident,slotId:'work:'+resident.id,teamId:team.id,position:transform(dock.toArray(),team).toArray(),yaw:station.yaw+team.yaw+Math.PI,approach:approach.map(p=>transform(p.toArray(),team).toArray()),station};
 });
}
export const FACILITIES=Object.freeze([
 {id:'tea',x:-46,z:-4,yaw:Math.PI/2,w:15,d:12},
 {id:'pond',x:23,z:-4,yaw:0,w:17,d:14},
 {id:'rest',x:-23,z:-4,yaw:0,w:18,d:16},
 {id:'games',x:46,z:-4,yaw:-Math.PI/2,w:28,d:16},
]);
export const WALKS=Object.freeze([
 [[[0,-23.5],[0,-17]],8],[[[0,9],[0,19.95]],8],[[[-35,-17],[35,-17]],8],[[[-35,9],[35,9]],8],
 ...[-10,10,-35,35].map(x=>[[[x,-17],[x,x===-10||x===10?33:9]],6]),[[[-10,33],[10,33]],6],[[[0,28.05],[0,42]],8],
 ...[-30.5,30.5].flatMap(x=>[[[[x,-21.2],[x,-17]],6],[[[x,13.2],[x,9]],6]]),
 [[[-23,4],[-23,9]],6],[[[23,3],[23,9]],6],[[[-23,-12],[-23,-17]],6],[[[23,-11],[23,-17]],6],[[[-40,-4],[-35,-4]],6],[[[38,-4],[35,-4]],6],
 [[[0,-17],[0,-14],[-10,-14],[-10,6],[0,6],[0,9]],6],[[[0,-14],[10,-14],[10,6],[0,6]],6],
 [[[-35,-17],[-56.5,-17],[-56.5,9],[-35,9]],6],[[[-60.5,-4],[-56.5,-4]],6],
]);
export function leisurePlaces(){
 const defs={tea:[[-4.7,-2.3],[4.7,-2.3],[-4.7,3.2],[4.7,3.2]],pond:[[-6.1,-.8],[6.1,-.8],[-3.1,4.5],[3.1,4.5]],rest:[[-5.6,-4],[5.6,-4],[-5.6,4],[5.6,4]],games:[-6.8,6.8].flatMap(x=>[0,1,2,3].map(i=>[x+Math.sin(i*Math.PI/2)*4.3,Math.cos(i*Math.PI/2)*4.3]))};
 return FACILITIES.flatMap(plot=>defs[plot.id].map(([x,z],i)=>{
  const table=i<4?-6.8:6.8;
  const approach=plot.id==='rest'?[0,.36,z]:plot.id==='tea'?[x,.36,z<0?-5.2:5.2]:plot.id==='pond'?[x,.36,z<0?-5.4:6.3]:[table+(x-table)*1.5,.36,z*1.5];
  return {id:'leisure:'+plot.id+':'+i,kind:plot.id,group:plot.id==='games'?'games:'+Math.floor(i/4):plot.id,position:transform([x,plot.id==='rest'?1.15:.89,z],plot),approach:transform(approach,plot),face:transform([plot.id==='games'?table:0,.89,plot.id==='pond'?-.8:plot.id==='rest'?z-2:0],plot),plot,local:[x,z]};
 }));
}
