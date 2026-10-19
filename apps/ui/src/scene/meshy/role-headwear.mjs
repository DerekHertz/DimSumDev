import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {GROVE_ROLES} from './grove-style.mjs';
import {createGroveHeadwear} from './grove-headwear.mjs';

const SELECTED = new Set(['knowledge-keeper','release-manager','stem-cub']);

// Bao-local coordinates: feet=0, crown approximately3, front=+Z.
// Scenery headwear keeps its established geometry; dispatchable roles use Grove.
export function createRoleHeadwear(roleId,options={}) {
  if(GROVE_ROLES[roleId])return createGroveHeadwear(roleId,options);
  if (!SELECTED.has(roleId)) return null;
  const source = new T.Group();
  const material = color => new T.MeshStandardMaterial({color,roughness:.88});
  const m = Object.fromEntries(Object.entries({ivory:'#faf1db',jade:'#527f73',ink:'#292e31',indigo:'#364b77',red:'#b9322d',rose:'#c58e86',blue:'#869ec1',leather:'#654433',gold:'#b99a59'}).map(([key,color])=>[key,material(color)]));
  const add=(geometry,mat,at=[0,0,0],scale=[1,1,1])=>{const mesh=new T.Mesh(geometry,mat);mesh.position.fromArray(at);mesh.scale.fromArray(scale);source.add(mesh);return mesh;};
  const box=(size,mat,at)=>add(new T.BoxGeometry(...size),mat,at);
  const orb=(r,mat,at,scale=[1,1,1])=>add(new T.SphereGeometry(r,20,12),mat,at,scale);
  const tube=(points,r,mat)=>add(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),Math.max(12,points.length*4),r,6,false),mat);
  const ring=(r,t,mat,at,scale=[1,1,1],vertical=false)=>{const mesh=add(new T.TorusGeometry(r,t,6,48),mat,at,scale);if(!vertical)mesh.rotation.x=Math.PI/2;return mesh;};
  const band=(mat,y=.025,h=.09,rx=.46,rz=.39)=>add(new T.CylinderGeometry(1,1,h,48,1,true),mat,[0,y,0],[rx,1,rz]);
  const crown=(mat,h=.3,rx=.46,rz=.39)=>add(new T.LatheGeometry(Array.from({length:21},(_,i)=>{const a=i/20*Math.PI/2;return new T.Vector2(Math.cos(a)*rx,Math.sin(a)*h);}),48),mat,[0,0,0],[1,1,rz/rx]);
  const badge=(mat=m.ivory)=>{const disc=add(new T.CylinderGeometry(.06,.06,.009,24),m.gold,[0,.08,.4]);disc.rotation.x=Math.PI/2;orb(.047,m.ink,[0,.08,.408],[1,1,.08]);const inset=box([.047,.047,.005],mat,[0,.08,.418]);inset.rotation.z=Math.PI/4;};
  const stitches=(mat,y=.04)=>{for(let i=0;i<40;i++){const a=i/40*Math.PI*2;const stitch=box([.006,.016,.005],mat,[Math.sin(a)*.463,y,Math.cos(a)*.393]);stitch.rotation.set(0,a,.35);}};
  const scholar=(mat)=>{band(mat,.04,.1);crown(mat,.18);box([.62,.18,.42],mat,[0,.19,-.05]).rotation.x=-.16;for(const x of[-.3,.3])tube([[x,.11,.19],[x,.31,.13],[x,.32,-.24]],.005,m.gold);stitches(m.gold,.055);badge();};
  if(roleId==='knowledge-keeper') {
    scholar(m.ink);
    for(const x of[-.35,.35]){const tail=box([.16,.46,.027],m.ink,[x,-.12,-.17]);tail.rotation.set(0,x<0?-.2:.2,x<0?-.25:.25);}
    orb(.033,m.jade,[0,.08,.423],[1,1,.35]);
  } else if(roleId==='stem-cub') {
    band(m.ivory,.025,.12);
    const points=[[.43,0],[.39,.14],[.31,.29],[.23,.39],[.13,.46],[.06,.5],[.007,.53]].map(p=>new T.Vector2(...p));
    const cap=add(new T.LatheGeometry(points,48),m.blue,[0,0,0],[1,1,.9]),positions=cap.geometry.attributes.position;
    for(let i=0;i<positions.count;i++){const y=positions.getY(i);positions.setX(i,positions.getX(i)-(y/.53)**2*.52);positions.setY(i,y-.23*(y/.53)**3);}
    cap.geometry.computeVertexNormals();orb(.084,m.ivory,[-.52,.3,0]);
    for(const[x,y,z]of[[-.05,.23,.3],[.19,.16,.3],[-.27,.32,.18],[-.2,.1,.33],[.32,.1,.23]]){
      const star=new T.Shape();for(let i=0;i<10;i++){const a=i*Math.PI/5,r=i%2?.012:.03;i?star.lineTo(Math.sin(a)*r,Math.cos(a)*r):star.moveTo(Math.sin(a)*r,Math.cos(a)*r);}star.closePath();add(new T.ExtrudeGeometry(star,{depth:.004,bevelEnabled:false}),m.ivory,[x,y,z]);
    }
    orb(.04,m.ivory,[-.1,.2,.28]);
  } else if(roleId==='release-manager') {
    // A narrow wrap sits on the upper forehead, rather than floating above the ears.
    band(m.red,0,.085,.59,.49);
    for(let i=0;i<24;i++){const a=i/24*Math.PI*2;const stitch=box([.012,.012,.008],m.ivory,[Math.sin(a)*.594,.018,Math.cos(a)*.494]);stitch.rotation.y=a;}
    orb(.037,m.red,[.59,0,.04]);
    for(const side of[-1,1]){
      ring(.044,.013,m.red,[.61+side*.023,.034,.04+side*.035],[.7,1,1],true);
      box([.052,.16,.018],m.red,[.61+side*.025,-.07,.04+side*.035]).rotation.z=side*.18;
    }
  }
  source.scale.setScalar(roleId==='release-manager'?1:1.35);
  source.position.set(0,roleId==='release-manager'?2.76:2.87,.1);
  source.updateMatrixWorld(true);
  const batches=new Map();source.traverse(node=>{if(!node.isMesh)return;const geometry=node.geometry.index?node.geometry.toNonIndexed():node.geometry.clone();geometry.applyMatrix4(node.matrixWorld);const parts=batches.get(node.material)||[];parts.push(geometry);batches.set(node.material,parts);});
  const result=new T.Group();result.name=`Role headwear · ${roleId}`;
  for(const[mat,parts]of batches){const mesh=new T.Mesh(mergeGeometries(parts,false),mat);mesh.castShadow=true;result.add(mesh);parts.forEach(p=>p.dispose());}
  source.traverse(node=>node.geometry?.dispose());
  for(const mat of Object.values(m))if(!batches.has(mat))mat.dispose();
  result.userData={headwearRole:roleId};return result;
}
