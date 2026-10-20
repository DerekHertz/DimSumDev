import * as T from 'three';
import { createSurfaceNavigation } from './navigation.mjs';
import { GROUND } from './plush/assembly.mjs';

// Collision proxies describe standing surfaces and furniture, rather than rasterising decorative meshes.
export function createGardenNavigation(garden){
 const root=new T.Group(),obstacles=[];
 const box=(parent,size,at)=>{const m=new T.Mesh(new T.BoxGeometry(...size));m.position.fromArray(at);parent.add(m);return m;};
 for(const[id,asset]of Object.entries(garden.assets)){
  const g=new T.Group();g.position.copy(asset.root.position);g.rotation.copy(asset.root.rotation);root.add(g);
  const work=['pass','pantry','front','steamers'].includes(id);
  if(work){
   const floor=id==='steamers'?.40:.315;box(g,[11.9,floor,7.9],[0,floor/2,0]);
   for(let i=0;i<2;i++)box(g,[4.4,.13+i*.12,.52],[0,(.13+i*.12)/2,4.50-i*.43]);
   for(const x of[-5.4,5.4])for(const z of[-3.25,3.1])box(g,[.31,4,.31],[x,2.25,z]);
   for(const x of[-3.05,3.05]){box(g,[3.5,1.25,1.40],[x,floor+.625,-.64]);box(g,[3.35,2.55,.64],[x,floor+1.275,-2.65]);}
   box(g,[1.55,1.3,.79],[0,.965,-2.86]);
  }else if(id==='library'){
   box(g,[9.25,.42,7.4],[0,.21,0]);for(const x of[-4.3,4.3])box(g,[.22,4,6.6],[x,2.42,0]);box(g,[8.7,4,.2],[0,2.42,-3.25]);for(const x of[-3,3])box(g,[2.55,4,.2],[x,2.42,3.25]);
   box(g,[3.65,.22,.7],[0,.11,4.16]);box(g,[3.3,.34,.7],[0,.17,3.85]);
   for(const x of[-3.25,3.25])box(g,[1.3,2.9,4.5],[x,1.87,-.9]);box(g,[2.9,1.23,1.1],[0,1.035,-2.0]);
  }else if(id==='festival'){
   box(g,[12.6,.635,9.4],[0,.3175,-.1]);for(let i=0;i<3;i++)box(g,[4.3,.16*(i+1),.55],[0,.08*(i+1),5.5-i*.45]);box(g,[11.5,.42,3.1],[0,.845,-2.1]);
  }else if(id==='mahjong'){
   box(g,[8.8,.375,7.7],[0,.1875,0]);box(g,[3.5,.17,.68],[0,.085,4.46]);box(g,[3,.28,.68],[0,.14,4.05]);box(g,[2.5,1.2,2.5],[0,.975,0]);
  }else if(id==='tea'){
   // The existing low garden island is the intermediate step up to the tea deck.
   const island=new T.Mesh(new T.CylinderGeometry(1,1,.21,64));island.scale.set(4.85,1,3.75);island.position.y=.105;g.add(island);
   box(g,[4.35,.43,3.65],[-1.8,.215,-.55]);box(g,[2.55,1.0,1.0],[-1.65,.93,.02]);
   for(let i=0;i<17;i++){const t=(i+.5)/17,y=.31+.42*Math.sin(t*Math.PI);box(g,[.24,y,.80],[.28+t*3.88,y/2,1.18]);}
   for(const [x,z,radius]of[[-2.9,1,.45],[-.30,1,.45],[-1.45,-1.5,.40],[-.42,1.12,.40]]){
    const at=asset.root.localToWorld(new T.Vector3(x,0,z));obstacles.push({type:'circle',x:at.x,z:at.z,radius});
   }
  }else if(id==='sleepy'){
   box(g,[6.5,.20,5.8],[0,.10,0]);box(g,[2.4,1.25,3.25],[0,.825,0]);
  }
 }
 // The round table remains the physical home of the live meeting feature.
 const bridge=new T.Group();bridge.position.copy(garden.landscape.root.position);root.add(bridge);const deck=new T.Group();deck.position.set(-3.07,.32,1.20);deck.rotation.y=.06;bridge.add(deck);
 for(let i=0;i<21;i++){const t=(i+.5)/21,h=.455+.28*Math.sin(t*Math.PI);box(deck,[.15,h-.32,1.22],[-1.38+t*2.76,(h-.32)/2,0]);}
 box(root,[4,1.1,2.35],[0,GROUND+.55,3.15]);
 for(const furniture of garden.welcomeFurniture||[])box(root,furniture.size,furniture.position);
 garden.root.traverse(n=>{if(n.name==='Soft bamboo cluster'){const p=n.getWorldPosition(new T.Vector3()),s=n.getWorldScale(new T.Vector3());obstacles.push({type:'circle',x:p.x,z:p.z,radius:.25*s.x});}});
 const nav=createSurfaceNavigation([root],{placement:.20,floorRadius:70,baseY:GROUND});
 root.traverse(n=>{n.geometry?.dispose();n.material?.dispose();});
 const inside=(x,z)=> (Math.abs(x)/46.4)**(2/.58)+(Math.abs(z+4)/41.4)**(2/.58)<1;
 const groundAt=nav.groundAt;
 return{obstacles,floorRadius:70,floorCenter:{x:0,z:-4},eyeHeight:1.82,navigation:{...nav,groundAt(x,z,previous=GROUND,radius=.26,height=2.04){
  if(![[0,0],[radius,0],[-radius,0],[0,radius],[0,-radius]].every(([dx,dz])=>inside(x+dx,z+dz)))return null;
  const y=groundAt(x,z,previous,radius,height);if(y===null)return null;
  const tea=garden.assets.tea.root.worldToLocal(new T.Vector3(x,0,z));if((tea.x-2.18)**2/1.72**2+(tea.z-.75)**2/1.43**2<1&&y<GROUND+.36)return null;
  const field=garden.landscape.root.worldToLocal(new T.Vector3(x,0,z));if(((field.x-5)/7.9)**2+((field.z-.6)/5.8)**2<1)return null;
  // The grove's stream is kept out of the walking surface, except on its footbridge.
  if(field.z>-4.8&&field.z<9&&Math.abs(field.x-(field.z<2.8?-3.2:field.z<5.2?-2.2:1.4))<.55&&!(field.z>.45&&field.z<1.95))return null;
  return y;
 }}};
}
