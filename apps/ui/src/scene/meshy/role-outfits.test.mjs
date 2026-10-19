import test from 'node:test';
import assert from 'node:assert/strict';
import {Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3} from 'three';
import {ROLE_OUTFITS, createRoleOutfit, completeRoleOutfits} from './role-outfits.mjs';
import {createRoleHeadwear} from './role-headwear.mjs';

const ROLES = ['orchestrator','product','architect','developer','scout','runner','debugger','qa','security','designer','herald','release-manager','knowledge-keeper','docs-writer','stem-cub'];
const HEADWEAR = ['orchestrator','product','architect','developer','scout','runner','qa','security','designer','herald','knowledge-keeper','release-manager','stem-cub'];
function templates() {
  const make = name => {
    const group = new Group(); group.name = name;
    const mesh = new Mesh(new BoxGeometry(.2,.3,.1), new MeshStandardMaterial({color:'#888888'}));
    mesh.name = name + ' fabric'; mesh.position.y = 1.8; group.add(mesh); return group;
  };
  return {vest:make('Wardrobe · developer-vest'), scarf:make('Wardrobe · qa-scarf'), securityVest:make('Wardrobe · security-vest'), headphones:make('Wardrobe · developer-headphones')};
}
function meshes(group) { const result=[]; group.traverse(node=>{if(node.isMesh)result.push(node);});return result; }

test('the approved wardrobe assigns exactly one vest or scarf to each canonical permanent role', () => {
  assert.equal(ROLE_OUTFITS.length,15);
  assert.deepEqual(ROLE_OUTFITS.map(row=>row.id).sort(),[...ROLES].sort());
  assert.equal(new Set(ROLE_OUTFITS.map(row=>row.id)).size,15);
  for(const row of ROLE_OUTFITS){
    assert.ok(['vest','scarf'].includes(row.clothing),row.id);
    assert.match(row.color,/^#[0-9a-f]{6}$/i,row.id+' has an explicit fabric color');
    assert.ok(row.headwear===null||typeof row.headwear==='string'&&row.headwear.length>0,row.id);
  }
  assert.deepEqual(ROLE_OUTFITS.filter(row=>row.headwear).map(row=>row.id).sort(),[...HEADWEAR].sort());
  assert.equal(ROLE_OUTFITS.find(row=>row.id==='developer').headwear,'headphones','the Developer has padded headphones without an added hat');
});

test('all role outfits reuse fitted template geometry and isolate fabric tints without mutating the originals', () => {
  const fitted=templates();
  for(const spec of ROLE_OUTFITS){
    const original=spec.clothing==='scarf'?fitted.scarf:fitted.vest;
    const originalMesh=meshes(original)[0],outfit=createRoleOutfit(spec.id,fitted);
    assert.equal(outfit.userData.outfitRole,spec.id);
    assert.equal(outfit.userData.clothing,spec.clothing);
    const fabric=outfit.getObjectByName(originalMesh.name);
    assert.ok(fabric,spec.id+' uses its approved fitted garment');
    assert.equal(fabric.geometry,originalMesh.geometry,spec.id+' shares geometry instead of duplicating fitted vertices');
    assert.notEqual(fabric.material,originalMesh.material,spec.id+' tint must not recolor another resident');
    assert.equal(originalMesh.material.color.getHexString(),'888888','source templates retain their color');
    assert.equal(original.parent,null,'source templates are not moved by the outfit factory');
    assert.ok(new Box3().setFromObject(outfit).getSize(new Vector3()).toArray().every(value=>Number.isFinite(value)&&value>0));
    if(spec.id==='developer')assert.ok(outfit.getObjectByName('Role headwear · developer').userData.cues.includes('Padded headphones'),'Developer has its approved padded headphone silhouette');
  }
  assert.throws(()=>createRoleOutfit('unknown-role',fitted),/Unknown role/);
  assert.throws(()=>createRoleOutfit('developer',{}),/Missing fitted vest/i,'missing fitted fabric must not silently create partial outfits');
});

test('approved role headwear and spectacles stay inside Bao local head space', () => {
  for(const role of ROLES){
    const headwear=createRoleHeadwear(role);
    if(!HEADWEAR.includes(role)){assert.equal(headwear,null,role+' has no added headwear');continue;}
    assert.ok(headwear?.isGroup,role);
    const bounds=new Box3().setFromObject(headwear),size=bounds.getSize(new Vector3());
    assert.ok(bounds.min.y>=2.2&&bounds.max.y<=3.75,`${role}: headwear must fit the crown of the 3-unit Bao body`);
    assert.ok(size.x<=(role==='qa'?2.4:2)&&size.z<=(role==='qa'?2.1:1.6),role+' must not become an oversized silhouette');
    assert.ok(Math.abs(bounds.getCenter(new Vector3()).x)<.4,role+' remains centered on the head');
    const parts=meshes(headwear);
    assert.ok(parts.length<=8,role+' remains batched for the browser');
    const triangles=parts.reduce((sum,node)=>sum+(node.geometry.index?.count??node.geometry.attributes.position.count)/3,0);
    assert.ok(triangles<=15000,role+' headwear remains lightweight');
  }
  assert.equal(createRoleHeadwear('unknown-role'),null);
});

test('Release Manager headband contacts the forehead with a narrow wrap and compact tails', () => {
  const headwear=createRoleHeadwear('release-manager'),bounds=new Box3().setFromObject(headwear),size=bounds.getSize(new Vector3());
  assert.ok(size.x<=1.42&&size.z<=1.16&&size.y<=.28,'the band must stay compact around the head');
  const front=new Box3();
  headwear.updateMatrixWorld(true);
  for(const node of meshes(headwear)){
    const positions=node.geometry.attributes.position;
    for(let i=0;i<positions.count;i++){
      const point=new Vector3().fromBufferAttribute(positions,i).applyMatrix4(node.matrixWorld);
      if(Math.abs(point.x)<.4&&point.z>.3)front.expandByPoint(point);
    }
  }
  assert.equal(front.isEmpty(),false,'the wrap reaches the front of the forehead');
  assert.ok(front.min.y>=2.66&&front.min.y<=2.77&&front.max.y>=2.75&&front.max.y<=2.86,`front wrap floats outside forehead height: ${front.min.y}..${front.max.y}`);
  assert.ok(front.max.y-front.min.y<=.12,'the forehead wrap must be a narrow band');
});

test('completing the wardrobe gives every resident an outfit that is retained by visitor clones', () => {
  const fitted=templates(),residents=new Group();
  for(const id of ROLES){const person=new Group();person.userData.roleId=id;residents.add(person);}
  const resident=id=>residents.children.find(person=>person.userData.roleId===id);
  resident('developer').add(fitted.vest,fitted.headphones);resident('qa').add(fitted.scarf);resident('security').add(fitted.securityVest);
  const report=completeRoleOutfits({residents});
  assert.deepEqual([...report.loaded].sort(),[...ROLES].sort());
  assert.deepEqual([...report.headwear].sort(),[...HEADWEAR].sort());
  for(const person of residents.children){
    const outfit=person.getObjectByName('Role outfit · '+person.userData.roleId);
    assert.ok(outfit,person.userData.roleId);
    const visitor=person.clone(true),cloned=visitor.getObjectByName(outfit.name);
    assert.ok(cloned,'same-role visitors keep the resident wardrobe');
    assert.equal(cloned.userData.outfitRole,person.userData.roleId);
    assert.equal(meshes(cloned)[0].geometry,meshes(outfit)[0].geometry,'visitors share the fitted geometry');
  }
});
