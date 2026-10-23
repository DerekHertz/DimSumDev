import * as Three from 'three';
import {SVGLoader} from 'three/addons/loaders/SVGLoader.js';
export async function loadOrnaments(){
 const result={};
 for(const runtime of ['claude','codex']){
  const artwork=await new SVGLoader().loadAsync('/den/runtime/'+runtime+'-mark.svg');
  const geometry=new Three.ExtrudeGeometry(artwork.paths.flatMap(path=>SVGLoader.createShapes(path)),{
   depth:runtime==='codex'?2:13.5,steps:1,curveSegments:2,
   bevelEnabled:true,bevelSegments:1,bevelSize:runtime==='codex'?.11:.26,bevelThickness:runtime==='codex'?.11:.50
  });
  geometry.computeBoundingBox();const bounds=geometry.boundingBox;
  const scale=.66/Math.max(bounds.max.x-bounds.min.x,bounds.max.y-bounds.min.y);
  geometry.scale(scale,-scale,scale);geometry.center();geometry.computeBoundingBox();
  if(runtime==='codex'){
   const positions=geometry.attributes.position,colors=new Float32Array(positions.count*3);
   const lower=new Three.Color('#3941FF'),middle=new Three.Color('#7A9DFF'),upper=new Three.Color('#B1A7FF');
   const height=geometry.boundingBox.max.y-geometry.boundingBox.min.y;
   for(let index=0;index<positions.count;index++){
    const fraction=(positions.getY(index)-geometry.boundingBox.min.y)/height;
    const color=fraction<.5?lower.clone().lerp(middle,fraction*2):middle.clone().lerp(upper,(fraction-.5)*2);
    color.toArray(colors,index*3);
   }
   geometry.setAttribute('color',new Three.BufferAttribute(colors,3));
  }
  const cap=new Three.MeshStandardMaterial({color:runtime==='codex'?'#ffffff':'#D97757',roughness:.48,metalness:.04,vertexColors:runtime==='codex'});
  const side=new Three.MeshStandardMaterial({color:runtime==='codex'?'#3655d5':'#9D432C',roughness:.58,metalness:.03});
  result[runtime]={geometry,materials:[cap,side],triangles:geometry.index?geometry.index.count/3:geometry.attributes.position.count/3};
 }
 return result;
}

export function createRuntimeOrnaments(den,artwork){
 const marks=new Map(),point=new Three.Vector3();
 function update(camera,height){
  const unitsPerPixel=camera.isOrthographic?(camera.top-camera.bottom)/Math.max(1,height):.04;
  for(const [model,{rig}]of den.pandaRigs){
   if(model.userData.modelUnavailable)continue;
   let mark=marks.get(model);if(!mark){const art=artwork[model.userData.runtime];if(!art)continue;mark=new Three.Mesh(art.geometry,art.materials);mark.name=model.userData.runtime+' runtime ornament';mark.castShadow=mark.receiveShadow=false;mark.raycast=()=>{};den.world.add(mark);marks.set(model,mark);}
   const head=rig.profile.envelope?.head,top=head?.labelTop??head?.top??3;point.set(0,top,0);model.localToWorld(point);
   const scale=Math.max(1,Math.min(3,14*unitsPerPixel/.66));mark.scale.setScalar(scale);mark.position.copy(point);mark.position.y+=.26+.33*scale;mark.quaternion.copy(camera.quaternion);mark.rotateY(-.18);
   const occluded=den.garden.roofMode!=='cutaway'&&den.garden.footprints.some(p=>{if(p.id==='pond')return false;const x=point.x-p.x,z=point.z-p.z,localX=x*Math.cos(p.yaw)-z*Math.sin(p.yaw),localZ=x*Math.sin(p.yaw)+z*Math.cos(p.yaw);return Math.abs(localX)<p.width/2&&Math.abs(localZ)<p.depth/2&&mark.position.y+scale*.33>5.9;});
   mark.visible=model.visible&&!occluded;
  }
  for(const [model,mark]of marks)if(!den.pandaRigs.has(model)){mark.removeFromParent();marks.delete(model);}
 }
 return {update,dispose(){for(const mark of marks.values())mark.removeFromParent();marks.clear();for(const art of Object.values(artwork)){art.geometry.dispose();art.materials.forEach(m=>m.dispose());}}};
}
