import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {batchStaticAssemblies} from './static-batches.mjs';

test('static batches preserve transformed geometry, materials, shadow flags and independent roof controls',()=>{
 const root=new T.Group();root.position.set(3,1,4);root.rotation.y=.4;root.userData.denInteraction={id:'archive.library'};
 const roof=new T.Group(),interior=new T.Group();roof.name='Roof';interior.name='Interior';interior.rotation.y=.7;interior.scale.set(1,2,1);root.add(roof,interior);
 const material=new T.MeshStandardMaterial(),roofMaterial=material.clone();roofMaterial.clippingPlanes=[new T.Plane(new T.Vector3(0,0,-1),-1)];
 const geometry=new T.BoxGeometry(1,1,1);
 for(let i=0;i<12;i++){const mesh=new T.Mesh(geometry,material);mesh.position.set(i,1,i%3);mesh.castShadow=true;mesh.receiveShadow=true;interior.add(mesh);}
 const noCast=new T.Mesh(geometry,material);noCast.position.y=4;noCast.castShadow=false;noCast.receiveShadow=true;interior.add(noCast);
 const noReceive=new T.Mesh(geometry,material);noReceive.position.y=6;noReceive.castShadow=true;noReceive.receiveShadow=false;interior.add(noReceive);
 for(let i=0;i<3;i++){const mesh=new T.Mesh(geometry,roofMaterial);mesh.position.set(i,8,0);mesh.castShadow=true;roof.add(mesh);}
 root.updateMatrixWorld(true);const before=new T.Box3().setFromObject(root,true),trianglesBefore=17*12;
 batchStaticAssemblies(root);
 const after=new T.Box3().setFromObject(root,true);assert.ok(before.min.distanceTo(after.min)<1e-5);assert.ok(before.max.distanceTo(after.max)<1e-5);
 let triangles=0;root.traverse(n=>{if(n.isMesh)triangles+=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;});assert.equal(triangles,trianglesBefore);
 assert.equal(interior.children.filter(n=>n.isMesh).length,3,'one batch per material/cast/receive combination');
 assert.equal(roof.children.length,1);assert.equal(roof.children[0].material,roofMaterial);assert.equal(roofMaterial.clippingPlanes.length,1);
 assert.ok(interior.children.some(n=>n.castShadow&&!n.receiveShadow));assert.ok(interior.children.some(n=>!n.castShadow&&n.receiveShadow));
 roof.visible=false;assert.equal(roof.children[0].parent.visible,false);assert.equal(interior.visible,true);assert.equal(interior.parent.userData.denInteraction.id,'archive.library');
 root.traverse(n=>n.geometry?.dispose());material.dispose();roofMaterial.dispose();
});

test('batching does not consume animated meshes or dispose geometry still retained outside a batch',()=>{
 const root=new T.Group(),assembly=new T.Group(),geometry=new T.BoxGeometry(1,1,1),material=new T.MeshBasicMaterial();root.add(assembly);
 const retained=new T.Mesh(geometry,material),animated=new T.SkinnedMesh(geometry,material);root.add(retained);assembly.add(animated);
 const a=new T.Mesh(geometry,material),b=new T.Mesh(geometry,material);a.castShadow=b.castShadow=true;assembly.add(a,b);
 let disposed=0;geometry.addEventListener('dispose',()=>disposed++);batchStaticAssemblies(root);
 assert.equal(disposed,0);assert.equal(animated.parent,assembly);assert.equal(retained.parent,root);assert.equal(a.parent,null);assert.equal(b.parent,null);
 assert.equal(assembly.children.filter(n=>n.isMesh&&!n.isSkinnedMesh).length,1);
 for(const n of assembly.children)if(n.geometry!==geometry)n.geometry.dispose();geometry.dispose();material.dispose();
});
