import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {gardenKit as originalKit} from '../plush/garden-kit.mjs';
export {COLORS,castsShadow} from '../plush/garden-kit.mjs';

export function gardenKit(name){
 const kit=originalKit(name),cache=new Map();
 kit.box=(parent,size,position,color,radius=.05)=>{
  const rounding=Math.min(radius,...size.map(value=>value*.24));
  const key=size.join(',')+':'+rounding;
  if(!cache.has(key))cache.set(key,new RoundedBoxGeometry(...size,1,rounding));
  return kit.mesh(parent,cache.get(key),color,position);
 };
 return kit;
}
