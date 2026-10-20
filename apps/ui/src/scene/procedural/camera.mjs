// Garden framing uses the same dolly-factor convention as the app's zoom switcher.
import { DEN_TARGET, TEAMS } from './bindings.mjs';
export const clampZoom=z=>Math.max(0.25,Math.min(1.2,z));
const sin=Math.sin(Math.atan(1/Math.SQRT2)),cos=Math.cos(Math.atan(1/Math.SQRT2));
export function cameraConfig({width,height,zoom=1,target=DEN_TARGET}) {
  // Hold the approved 94-unit garden width on desktop and phone, with room for the mountain skyline.
  const half=Math.max(63,104/(width/height))*clampZoom(zoom)/2;
  return {position:[target[0],target[1]+110*sin,target[2]+110*cos],target,up:[0,1,0],near:0.1,far:300,left:-half*width/height,right:half*width/height,top:half,bottom:-half};
}
export function clampTarget(target){
  return [Math.max(-40,Math.min(40,target[0])),Math.max(0,Math.min(5,target[1])),Math.max(-35,Math.min(35,target[2]))];
}
export function dragPan(target,{dx,dy},view){
  const c=cameraConfig({...view,target}),k=view.width/(c.right-c.left);
  return clampTarget([target[0]-dx/k,target[1],target[2]-dy/k/sin]);
}
export function keyPan(target,key,view){return dragPan(target,{dx:key==='ArrowLeft'?48:key==='ArrowRight'?-48:0,dy:0},view);}
export const pinchZoom=(zoom,from,to)=>clampZoom(zoom*from/Math.max(to,1));
export const wheelZoom=(zoom,delta)=>clampZoom(zoom*Math.exp(Math.max(-20,Math.min(20,delta*0.001))));
export function createDenCameraStore(base,onNavigate=()=>{},targets=null) {
  base.setTarget(DEN_TARGET);
  return {...base,
    goToLevel(level){onNavigate();base.goToLevel(level);if(level===1)base.setTarget(DEN_TARGET);},
    goToTeam(id){onNavigate();base.setZoom(base.levels?.[2]??0.75);const s=TEAMS[id];base.setTarget(targets?.[id]??(s?[s.x,1,s.z]:id==='pass'?[0,2,-10]:DEN_TARGET));},
  };
}
