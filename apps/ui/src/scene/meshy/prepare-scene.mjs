import {Scene,Plane,Vector3} from 'three';
import {createMeshyActors} from './actors.mjs';

export async function prepareDenScene(den,renderer,camera,scene,height,signal){
 const agents=createMeshyActors(den);
 try{
  den.ornaments?.update(camera,height);
  if(den.garden?.setRoofMode){
   const empty=new Scene(),planes=renderer.clippingPlanes,autoClear=renderer.autoClear;
   try{
    // compileAsync reads the clipping count left by the last render.
    renderer.autoClear=false;renderer.clippingPlanes=[new Plane(new Vector3(0,0,-1),0)];
    renderer.render(empty,camera);
    await renderer.compileAsync(den.world,camera,scene);
   }finally{
    renderer.clippingPlanes=planes;try{renderer.render(empty,camera);}finally{renderer.autoClear=autoClear;}
   }
   if(signal?.aborted)throw new DOMException('Scene load cancelled','AbortError');
  }
  await renderer.compileAsync(den.world,camera,scene);
  if(signal?.aborted)throw new DOMException('Scene load cancelled','AbortError');
  return agents;
 }catch(error){agents.dispose();throw error;}
}
