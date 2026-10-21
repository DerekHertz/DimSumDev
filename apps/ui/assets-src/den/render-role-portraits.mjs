// Offline authoring only: cached portraits use the live wardrobe, rig and props.
import * as T from 'three';
import {loadManifest,loadModel,disposeWorld} from '../../src/scene/meshy/assets.mjs';
import {fitRoleAsset} from '../../src/scene/meshy/role-wardrobe.mjs';
import {ROLE_OUTFITS} from '../../src/scene/meshy/role-outfits.mjs';
import {createPandaAppearanceFactory} from '../../src/scene/meshy/panda-appearance.mjs';

// `roles` limits the run to some roles (team-and-den-ux/23 renders just its two species).
export async function renderRolePortraits(onImage,{runtime='claude',roles=null}={}){
 const assets=await loadManifest(),resources=new T.Group();let factory;
 const renderer=new T.WebGLRenderer({antialias:true,alpha:true});
 renderer.setSize(512,512);renderer.setPixelRatio(1);renderer.outputColorSpace=T.SRGBColorSpace;
 renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 const scene=new T.Scene();scene.add(new T.HemisphereLight('#fff8ec','#b1c8b6',1.8));
 const light=new T.DirectionalLight('#fff5e6',2.3);light.position.set(-3,5,6);scene.add(light);
 const fill=new T.DirectionalLight('#e4f1ff',.8);fill.position.set(3,3,3);scene.add(fill);
 const camera=new T.OrthographicCamera(-1.58,1.58,1.58,-1.58,.1,20);camera.position.set(0,1.9,6);camera.lookAt(0,1.9,0);
 try{
  const sources=[];
  for(const id of ['bao','wardrobe.developer-vest','wardrobe.qa-scarf']){const source=await loadModel(assets[id].url);resources.add(source);sources.push(source);}
  const [body,vestSource,scarfSource]=sources,vest=fitRoleAsset(vestSource,'developer-vest'),scarf=fitRoleAsset(scarfSource,'qa-scarf');resources.add(vest,scarf);
  const characters={};
  for(const [key,asset]of Object.entries(assets))if(key.startsWith('characters.')){const source=await loadModel(asset.url);resources.add(source);characters[asset.characterId||asset.roleId]=source;}
  factory=createPandaAppearanceFactory({body,vest,scarf,characters});resources.add(factory.outfits);
  const specs=ROLE_OUTFITS.filter(spec=>!roles||roles.includes(spec.id));
  for(const spec of specs){
   const panda=factory.createPanda(spec.id,{runtime});panda.model.scale.setScalar(1);scene.add(panda.model);panda.rig.poseIdle(0);
   // Head-and-shoulders: 1.1 below the crown, as Bao's 3-unit frame is centred at 1.9.
   const centre=(panda.rig.profile.height??3)-1.1;camera.position.set(0,centre,6);camera.lookAt(0,centre,0);
   renderer.render(scene,camera);await onImage(spec.id,renderer.domElement.toDataURL('image/webp',.92));factory.destroyPanda(panda.model);
  }
  return {count:specs.length,runtime,format:'512px cached WebP',newPaidAssets:0};
 }finally{factory?.dispose();disposeWorld(resources);renderer.dispose();renderer.forceContextLoss();}
}
