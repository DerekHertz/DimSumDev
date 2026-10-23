// Garden framing uses the same dolly-factor convention as the app's zoom switcher.
import { DEN_TARGET, TEAMS } from './bindings.mjs';
export const clampZoom=z=>Math.max(0.55,Math.min(1.2,z));
export const DEFAULT_ORBIT=Object.freeze({yaw:0,pitch:Math.atan(1/Math.SQRT2)});
export function clampOrbit({yaw,pitch}){
  return {yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw)),pitch:Math.max(Math.PI/9,Math.min(5*Math.PI/12,pitch))};
}
export function dragOrbit(orbit,{dx,dy}){return clampOrbit({yaw:orbit.yaw-dx*.006,pitch:orbit.pitch-dy*.006});}
export function cameraConfig({width,height,zoom=1,target=DEN_TARGET,orbit=DEFAULT_ORBIT}) {
  // Hold the approved 94-unit garden width on desktop and phone, with room for the mountain skyline.
  const half=Math.max(92,146/(width/height))*clampZoom(zoom)/2;
  const {yaw,pitch}=clampOrbit(orbit),radius=110*Math.cos(pitch);
  return {position:[target[0]+radius*Math.sin(yaw),target[1]+110*Math.sin(pitch),target[2]+radius*Math.cos(yaw)],target,up:[0,1,0],near:0.1,far:300,left:-half*width/height,right:half*width/height,top:half,bottom:-half};
}
export function clampTarget(target){
  return [Math.max(-40,Math.min(40,target[0])),Math.max(0,Math.min(5,target[1])),Math.max(-35,Math.min(35,target[2]))];
}
export function dragPan(target,{dx,dy},view){
  const c=cameraConfig({...view,target}),k=view.width/(c.right-c.left);
  const {yaw,pitch}=clampOrbit(view.orbit??DEFAULT_ORBIT),x=-dx/k,z=-dy/k/Math.sin(pitch);
  return clampTarget([target[0]+x*Math.cos(yaw)+z*Math.sin(yaw),target[1],target[2]-x*Math.sin(yaw)+z*Math.cos(yaw)]);
}
export function keyPan(target,key,view){return dragPan(target,{dx:key==='ArrowLeft'?48:key==='ArrowRight'?-48:0,dy:key==='ArrowUp'?48:key==='ArrowDown'?-48:0},view);}
export const pinchZoom=(zoom,from,to)=>clampZoom(zoom*from/Math.max(to,1));
export const wheelZoom=(zoom,delta)=>clampZoom(zoom*Math.exp(Math.max(-20,Math.min(20,delta*0.001))));
export function createDenCameraStore(base,onNavigate=()=>{},targets=null) {
  base.setTarget(DEN_TARGET);
  let orbit={...DEFAULT_ORBIT};const subs=new Set();
  return {...base,
    getOrbit:()=>({...orbit}),
    setOrbit(value){const next=clampOrbit(value);if(next.yaw===orbit.yaw&&next.pitch===orbit.pitch)return;orbit=next;subs.forEach(fn=>fn());},
    subscribe(fn){subs.add(fn);const off=base.subscribe(fn);return()=>{subs.delete(fn);off();};},
    goToLevel(level){onNavigate();base.goToLevel(level);if(level===1){base.setTarget(DEN_TARGET);orbit={...DEFAULT_ORBIT};subs.forEach(fn=>fn());}},
    goToTeam(id){onNavigate();base.setZoom(base.levels?.[2]??0.75);const s=TEAMS[id];base.setTarget(targets?.[id]??(s?[s.x,1,s.z]:id==='pass'?[0,2,-10]:DEN_TARGET));},
  };
}
