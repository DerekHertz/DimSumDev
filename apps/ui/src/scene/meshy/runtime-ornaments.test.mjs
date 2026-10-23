import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createRuntimeOrnaments} from './runtime-ornaments.mjs';
test('55-L: shared decorative marks hide behind an arch, suppress crowd overlap and clean up removed models',()=>{
 const world=new T.Group(),model=new T.Group();model.userData.runtime='codex';world.add(model);
 const geometry=new T.BoxGeometry(.66,.66,.04),materials=[new T.MeshBasicMaterial()],art={codex:{geometry,materials}};
 const den={world,pandaRigs:new Map([[model,{rig:{profile:{envelope:{head:{top:3}}}}}]]),garden:{roofMode:'cutaway',footprints:[],assets:{}},walkWorld:{physicalObstacles:[{min:[-1,0,4],max:[1,6,5],name:'Entrance arch'}]}};
 const camera=new T.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(0,4,10);camera.lookAt(0,3,0);camera.updateMatrixWorld(true);
 const marks=createRuntimeOrnaments(den,art);try{
  marks.update(camera,800);const mark=world.children.find(n=>n.name==='codex runtime ornament');assert.ok(mark);assert.equal(mark.visible,false,'arch hides decorative mark');
  den.walkWorld.physicalObstacles=[];marks.update(camera,800);assert.equal(mark.visible,true);assert.equal(mark.castShadow,false);
  const second=model.clone();world.add(second);den.pandaRigs.set(second,den.pandaRigs.get(model));marks.update(camera,800);
  assert.equal(world.children.filter(n=>n.name==='codex runtime ornament'&&n.visible).length,1,'crowded marks do not pile up over a face');
  den.pandaRigs.delete(model);marks.update(camera,800);assert.equal(mark.parent,null);
 }finally{marks.dispose();}
});
