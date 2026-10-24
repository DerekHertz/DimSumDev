import * as T from 'three';
import {createApprovedGarden} from './approved-garden.mjs';
import {createApprovedNavigation} from './approved-navigation.mjs';
import { ROLE_OUTFITS } from './role-outfits.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import { loadManifest, loadModel, disposeWorld } from './assets.mjs';
import { addLiveFixtures } from './live-fixtures.mjs';
import { materials } from './garden.mjs';
import { NAVIGATION_TARGETS, WALK_START } from './layout.mjs';
import {gardenRoutineSpots} from './daily-routines.mjs';
import {loadOrnaments,createRuntimeOrnaments} from './runtime-ornaments.mjs';

const active=signal=>{if(signal?.aborted)throw new DOMException('Scene load cancelled','AbortError');};

export async function createMeshyWorld(renderer,{signal,onProgress=()=>{}}={}){
 const resources=new T.Group(),residents=new T.Group(),rigs=new Map();let garden,appearances,disposed=false;
 const den={world:new T.Group(),residents,roleTools:new T.Group(),vegetation:new T.Group(),zones:new Map(),plan:[],hats:[],renderer,frontier:new Map(),pandaRigs:rigs,navigationTargets:NAVIGATION_TARGETS,walkStart:WALK_START};
 den.dispose=()=>{if(disposed)return;disposed=true;den.ornaments?.dispose();appearances?.dispose();garden?.dispose();disposeWorld(den.world);disposeWorld(resources);};
 try{
  den.assets=await loadManifest(signal);active(signal);
  onProgress('Opening the teahouse garden…');
  const props={};
  for(const id of ['chair','lantern','tree']){const source=await loadModel(den.assets['teahouse.'+id].url);resources.add(source);active(signal);props[id]=source;}
  garden=createApprovedGarden({props});resources.clear();den.garden=garden;den.world.add(garden.root,residents,den.roleTools,den.vegetation);den.world.name='Dim Sum Dev · plush bamboo garden';
  onProgress('Loading the approved residents…');
  const characters={};den.characterLoad={loaded:[],failed:[]};
  for(const [key,asset]of Object.entries(den.assets))if(key.startsWith('characters.')&&asset.roleId){
   try{const source=await loadModel(asset.url);resources.add(source);active(signal);characters[asset.characterId||asset.roleId]=source;den.characterLoad.loaded.push(asset.characterId||asset.roleId);}
   catch(error){if(error?.name==='AbortError')throw error;den.characterLoad.failed.push({role:asset.characterId||asset.roleId,message:error.message});}
  }
  appearances=createPandaAppearanceFactory({characters,approvedOnly:true});resources.add(appearances.outfits);den.pandaRigs=appearances.instances;
  den.createPanda=appearances.createPanda;
  den.destroyPanda=appearances.destroyPanda;
  const workspaces=new Map(),records=[];
  const homes=garden.docks;
  for(const home of homes){const panda=den.createPanda(home.role,{runtime:home.runtime}),asset=garden.assets[home.teamId];panda.model.position.fromArray(home.position);panda.model.rotation.y=home.yaw;panda.model.name=home.name+' · '+home.runtime;panda.model.userData.actorKey=home.id;residents.add(panda.model);panda.rig.poseIdle(0);const record={...home,team:home.teamId||'center',person:panda.model,group:asset?.root||garden.welcome,loaded:true};workspaces.set(home.id,record);records.push({...home,person:home.position,loaded:true});}
  den.propManifest=homes;den.roleWorkspaces={workspaces,records,group:residents,anchors:{},errors:[],toolsCreated:homes.length};
  den.wardrobe={loaded:records.map(s=>({id:s.id,role:s.id})),failed:[],missing:[]};den.roleOutfits={loaded:records.map(s=>s.id),headwear:ROLE_OUTFITS.filter(s=>s.headwear&&workspaces.has(s.id)).map(s=>s.id)};den.developerWorkstation={loaded:true,source:'Three.js',style:'Coding desk, terminal, keyboard and tools'};
  for(const p of garden.places){const asset=garden.assets[p.id];if(asset)den.zones.set(p.id,asset.root);den.plan.push({id:p.id,label:p.name,x:p.x,z:p.z,radius:Math.max(p.w,p.d)/2});}
  den.zones.set('center',garden.welcome);den.zones.set('pavilion',garden.assets.tea.root);den.zones.set('games',garden.assets.games.root);
  garden.assets.library.root.userData.denInteraction={zone:'archive',intent:'open-library',id:'archive.library'};
  den.ambient={pose(){},dispose(){}};
  addLiveFixtures(den,materials());active(signal);den.world.updateMatrixWorld(true);
  onProgress('Connecting the paths and walk-in entrances…');den.walkWorld=createApprovedNavigation(garden);renderer.localClippingEnabled=true;renderer.shadowMap.needsUpdate=true;
  den.routineSpots=gardenRoutineSpots(garden);den.feedKoi=()=>{};
  try{den.ornaments=createRuntimeOrnaments(den,await loadOrnaments());active(signal);}catch(error){if(error.name==='AbortError')throw error;den.ornamentError=error.message;}
  den.world.userData.presentationLayout={kind:'approved-plush-garden',structurePositions:garden.places.map(p=>({id:p.id,x:p.x,z:p.z,rotation:p.rotation})),roleWorkspaces:records};
  return den;
 }catch(error){den.dispose();throw error;}
}
