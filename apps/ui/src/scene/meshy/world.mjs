import * as T from 'three';
import { createDenScene, GROUND } from './plush/assembly.mjs';
import { gardenKit } from './plush/garden-kit.mjs';
import { ROLE_OUTFITS } from './role-outfits.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import { fitRoleAsset } from './role-wardrobe.mjs';
import { loadManifest, loadModel, disposeWorld } from './assets.mjs';
import { populateAmbientGarden } from './ambient-garden.mjs';
import { createGardenNavigation } from './garden-navigation.mjs';
import { addLiveFixtures } from './live-fixtures.mjs';
import { materials } from './garden.mjs';
import { NAVIGATION_TARGETS, WALK_START } from './layout.mjs';
import {gardenRoutineSpots} from './daily-routines.mjs';
import {residentHomes} from './resident-homes.mjs';

const active=signal=>{if(signal?.aborted)throw new DOMException('Scene load cancelled','AbortError');};

export async function createMeshyWorld(renderer,{signal,onProgress=()=>{}}={}){
 const resources=new T.Group(),residents=new T.Group(),rigs=new Map();let garden,ambient,meeting,appearances,disposed=false;
 const den={world:new T.Group(),residents,roleTools:new T.Group(),vegetation:new T.Group(),zones:new Map(),plan:[],hats:[],renderer,frontier:new Map(),pandaRigs:rigs,navigationTargets:NAVIGATION_TARGETS,walkStart:WALK_START};
 den.dispose=()=>{if(disposed)return;disposed=true;ambient?.dispose();if(ambient){disposeWorld(ambient.props);for(const outfit of ambient.outfits)disposeWorld(outfit);}appearances?.dispose();garden?.dispose();meeting?.dispose();disposeWorld(den.world);disposeWorld(resources);};
 try{
  den.assets=await loadManifest(signal);active(signal);
  onProgress('Opening the bright bamboo garden…');garden=createDenScene();den.garden=garden;den.world.add(garden.root,residents,den.roleTools,den.vegetation);den.world.name='Dim Sum Dev · plush bamboo garden';
  onProgress('Fitting the pandas’ role attire…');
  const ids=['bao','wardrobe.developer-vest','wardrobe.qa-scarf','wardrobe.developer-headphones'];
  const sources=[];for(const id of ids){const source=await loadModel(den.assets[id].url);resources.add(source);sources.push(source);active(signal);}
  const [body,vestSource,scarfSource,headphonesSource]=sources,vest=fitRoleAsset(vestSource,'developer-vest'),scarf=fitRoleAsset(scarfSource,'qa-scarf'),headphones=fitRoleAsset(headphonesSource,'developer-headphones'),securityVest=fitRoleAsset(vestSource,'security-vest');resources.add(vest,scarf,headphones,securityVest);
  appearances=createPandaAppearanceFactory({body,vest,scarf,headphones,securityVest});resources.add(appearances.outfits);den.pandaRigs=appearances.instances;
  den.createPanda=appearances.createPanda;
  den.destroyPanda=appearances.destroyPanda;
  const workspaces=new Map(),records=[];
  const homes=residentHomes(garden);
  for(const home of homes){const panda=den.createPanda(home.role,{runtime:home.runtime}),asset=garden.assets[home.stationId];panda.model.position.fromArray(home.position);panda.model.rotation.y=home.yaw;panda.model.name=home.name+' · '+home.runtime;panda.model.userData.actorKey=home.id;residents.add(panda.model);panda.rig.poseIdle(0);const record={...home,station:home.stationId||'center',person:panda.model,group:asset?.root||garden.welcome,loaded:true};workspaces.set(home.id,record);records.push({...home,person:home.position,loaded:true});}
  den.propManifest=homes;den.roleWorkspaces={workspaces,records,group:residents,anchors:{},errors:[],toolsCreated:homes.length};
  den.wardrobe={loaded:records.map(s=>({id:s.id,role:s.id})),failed:[],missing:[]};den.roleOutfits={loaded:records.map(s=>s.id),headwear:ROLE_OUTFITS.filter(s=>s.headwear&&workspaces.has(s.id)).map(s=>s.id)};den.developerWorkstation={loaded:true,source:'Three.js',style:'Coding desk, terminal, keyboard and tools'};
  for(const p of garden.places){const asset=garden.assets[p.id];if(asset)den.zones.set(p.id,asset.root);den.plan.push({id:p.id,label:p.name,x:p.x,z:p.z,radius:Math.max(p.w,p.d)/2});}
  den.zones.set('center',garden.welcome);den.zones.set('pavilion',garden.assets.tea.root);den.zones.set('games',garden.assets.mahjong.root);
  garden.assets.library.root.userData.denInteraction={zone:'archive',intent:'open-library',id:'archive.library'};
  onProgress('Welcoming the festival crew and the garden pandas…');ambient=populateAmbientGarden(garden,{body,vest,headphones});den.ambient=ambient;
  // Keep the live meeting at Bao's table, in the same coordinates as its seat labels.
  meeting=gardenKit('Bao’s round table');meeting.root.userData.denInteraction={id:'center'};const fixedTable=meeting.group('Round table and legs');const table=meeting.cyl(fixedTable,1,.13,[0,GROUND+1.04,3.15],'paleWood');table.scale.set(2,1,1.18);for(const x of[-1.3,1.3])meeting.cyl(fixedTable,.09,.98,[x,GROUND+.49,3.15],'timber');const susan=meeting.group('Lazy susan',meeting.root,[0,GROUND+1.12,3.15]);meeting.teaSet(susan,[0,0,0],1.1);meeting.finish();den.world.add(meeting.root);
  addLiveFixtures(den,materials());active(signal);den.world.updateMatrixWorld(true);
  onProgress('Connecting the paths and walk-in entrances…');den.walkWorld=createGardenNavigation(garden);renderer.shadowMap.needsUpdate=true;
  den.routineSpots=gardenRoutineSpots(garden);den.feedKoi=()=>garden.assets.tea.koi.feed();
  den.world.userData.presentationLayout={kind:'approved-plush-garden',structurePositions:garden.places.map(p=>({id:p.id,x:p.x,z:p.z,rotation:p.rotation})),roleWorkspaces:records};
  return den;
 }catch(error){den.dispose();throw error;}
}
