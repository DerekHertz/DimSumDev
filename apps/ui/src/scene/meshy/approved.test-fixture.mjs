import * as T from 'three';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {readGlbGeometry} from '../../../assets-src/den/read-glb-geometry.mjs';
import {createPandaAppearanceFactory} from './panda-appearance.mjs';
import {createApprovedGarden} from './approved-garden.mjs';
import {createApprovedNavigation} from './approved-navigation.mjs';
import {createMeshyActors} from './actors.mjs';
import {leisurePlaces} from './approved-plan.mjs';
import {teahouseProps} from './teahouse.test-fixture.mjs';

export function approvedFixture({missing=[]}={}){
 globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
 const garden=createApprovedGarden({props:teahouseProps()}),characters={},residents=new T.Group();
 const manifest=JSON.parse(readFileSync(new URL('../../../public/den/manifest.json',import.meta.url)));
 for(const [id,asset]of Object.entries(manifest.assets))if(id.startsWith('characters.'))characters[asset.characterId||asset.roleId]=readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+asset.url,import.meta.url))));
 for(const key of missing)delete characters[key];
 const factory=createPandaAppearanceFactory({characters,approvedOnly:true}),workspaces=new Map();
 for(const dock of garden.docks){const panda=factory.createPanda(dock.role,{runtime:dock.runtime});panda.model.position.fromArray(dock.position);panda.model.rotation.y=dock.yaw;residents.add(panda.model);workspaces.set(dock.id,{person:panda.model});}
 const den={garden,residents,createPanda:factory.createPanda,destroyPanda:factory.destroyPanda,propManifest:garden.docks,roleWorkspaces:{workspaces},pandaRigs:factory.instances,walkWorld:createApprovedNavigation(garden),routineSpots:leisurePlaces()};
 const actors=createMeshyActors(den);
 return {den,actors,factory,tick(seconds,reduced=false){for(let t=0;t<Math.round(seconds*10);t++)actors.update(.1,reduced);},dispose(){actors.dispose();factory.dispose();garden.dispose();}};
}
