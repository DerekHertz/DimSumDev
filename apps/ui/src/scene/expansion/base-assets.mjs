import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createBao } from '../procedural/bao.mjs';
import { createTraditionalGear, TRADITIONAL_PROPS } from '../../review/traditional-props.mjs';

// One consistent, deliberately simple material vocabulary across the whole kit.
export const COLORS={cream:'#f3e9d1',ink:'#2d302c',wood:'#a87548',woodLight:'#ceab75',bamboo:'#d3bc86',jade:'#537e64',jadeDark:'#355749',leaf:'#739c62',grass:'#a5ba7d',stone:'#d2d0b6',roof:'#536855',gold:'#c6a05c',red:'#b46b59',lavender:'#aa98b0',amber:'#edb44b',blue:'#6d92a8'};
const materials=new Map();
const rigs=new WeakMap();
const extras=new WeakMap();
const mat=(c,roughness=.88)=>{const key=c+roughness;if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color:c,roughness}));return materials.get(key);};
const C=COLORS;
// den-mvp/25: the village is built without its illustrative pandas and their activity bubbles; the den's actor controller owns every live panda.
let residentsOn=true;
const group=name=>{const g=new THREE.Group();g.name=name;return g;};
function mesh(parent,geo,color,pos=[0,0,0]){const m=new THREE.Mesh(geo,typeof color==='string'?mat(color):color);m.position.set(...pos);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function box(p,size,pos,c,r=.07){return mesh(p,new RoundedBoxGeometry(...size,2,Math.min(r,...size.map(x=>x*.25))),c,pos);}
// den-mvp/25: facet counts follow the size on screen (the village is ~25 assets in one frame); big pads and drums keep 24.
const facets=(r,small,mid,big)=>r<.12?small:r<.35?mid:big;
function cyl(p,r,h,pos,c,top=r){return mesh(p,new THREE.CylinderGeometry(top,r,h,facets(r,8,14,24)),c,pos);}
function ball(p,r,pos,c,scale=[1,1,1]){const m=mesh(p,new THREE.SphereGeometry(r,facets(r,8,12,20),facets(r,5,8,12)),c,pos);m.scale.set(...scale);return m;}
function ring(p,r,t,pos,c){const m=mesh(p,new THREE.TorusGeometry(r,t,facets(t*3,4,5,6),r<.7?20:40),c,pos);m.rotation.x=Math.PI/2;return m;}
function beam(p,a,b,r,c){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),m=cyl(p,r,av.distanceTo(bv),av.clone().add(bv).multiplyScalar(.5).toArray(),c);m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),bv.sub(av).normalize());return m;}
function tube(p,points,r,c){const curve=new THREE.CatmullRomCurve3(points.map(v=>new THREE.Vector3(...v)));return mesh(p,new THREE.TubeGeometry(curve,24,r,facets(r,4,6,8),false),c);}
function at(p,g,pos,yaw=0,scale=1){g.position.set(...pos);g.rotation.y=yaw;g.scale.setScalar(scale);p.add(g);return g;}

function textPlane(p,text,pos,width=2,height=.5,color=C.ink,bg=C.cream){
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=Math.round(1024*height/width);
  const ctx=canvas.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle=color;
  ctx.font=`600 ${Math.floor(canvas.height*.45)}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,canvas.width/2,canvas.height/2,canvas.width*.9);
  const tx=new THREE.CanvasTexture(canvas);tx.colorSpace=THREE.SRGBColorSpace;
  const m=mesh(p,new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:tx,side:THREE.DoubleSide}),pos);m.castShadow=false;return m;
}
function sign(p,text,pos,w=2,c=C.jade){box(p,[w+.12,.6,.13],pos,c);textPlane(p,text,[pos[0],pos[1],pos[2]+.073],w,.46,C.cream,c);}
function floor(p,w=4,d=3,c=C.woodLight){box(p,[w,.2,d],[0,.11,0],c,.1);for(let x=-w/2+.3;x<w/2;x+=.36)box(p,[.012,.012,d-.12],[x,.216,0],C.wood,.004);}
function roundPad(p,r=2,c=C.stone){cyl(p,r,.14,[0,.06,0],c);ring(p,r-.12,.035,[0,.145,0],C.woodLight);}
function cushion(p,pos,c=C.jade,s=.6){box(p,[s,.2,s],pos,c,.1);box(p,[s*.83,.025,s*.83],[pos[0],pos[1]+.106,pos[2]],c,.012);}
function stool(p,pos,c=C.jade){cyl(p,.36,.14,[pos[0],pos[1]+.58,pos[2]],C.wood);cushion(p,[pos[0],pos[1]+.69,pos[2]],c,.65);for(const x of [-.23,.23])for(const z of [-.23,.23])beam(p,[pos[0]+x,pos[1],pos[2]+z],[pos[0]+x*.8,pos[1]+.53,pos[2]+z*.8],.055,C.wood);}
function bench(p,w,pos,c=C.wood){box(p,[w,.15,.65],[pos[0],pos[1]+.62,pos[2]],c);for(const x of [-w*.38,w*.38])box(p,[.14,.62,.48],[pos[0]+x,pos[1]+.31,pos[2]],C.wood);}

// Rounded, upturned roof sheets; wood battens articulate the eaves without ink outlines.
function roof(p,w=4,d=3,h=3.6,c=C.roof){
  const nx=32,nz=24,positions=[],indices=[];
  const y=(x,z)=>h+.65*(1-Math.abs(z)/(d/2))+.22*Math.pow(Math.abs(x)/(w/2),6)+.15*Math.pow(Math.abs(z)/(d/2),10);
  for(let j=0;j<=nz;j++)for(let i=0;i<=nx;i++){const x=(i/nx-.5)*w,z=(j/nz-.5)*d;positions.push(x,y(x,z),z);if(i<nx&&j<nz){const k=j*(nx+1)+i;indices.push(k,k+nx+1,k+1,k+1,k+nx+1,k+nx+2);}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();
  const material=mat(c).clone();material.side=THREE.DoubleSide;mesh(p,g,material);
  for(const z of [-d/2,d/2])tube(p,Array.from({length:17},(_,i)=>{const x=(i/16-.5)*w;return[x,y(x,z)-.035,z];}),.07,C.woodLight);
  for(let x=-w/2+.2;x<=w/2-.1;x+=.25)tube(p,Array.from({length:13},(_,i)=>{const z=(i/12-.5)*d;return[x,y(x,z)+.02,z];}),.012,c);
  tube(p,[[-w/2,h+.75,0],[0,h+.65,0],[w/2,h+.75,0]],.075,C.woodLight);
}
function pavilion(p,w=4,d=3,h=3.5,color=C.jade){floor(p,w-.2,d-.2);for(const x of [-w*.39,w*.39])for(const z of [-d*.36,d*.36]){cyl(p,.075,h,[x,h/2+.2,z],C.wood);cyl(p,.12,.12,[x,.3,z],C.woodLight);}roof(p,w,d,h);box(p,[w*.8,.12,.12],[0,h-.12,d*.36],color);}

function bamboo(p,pos,h=3,angle=0){const g=group('Bamboo');at(p,g,pos,angle);for(let i=0;i<3;i++){const x=(i-1)*.28,height=h*(.8+i*.1);cyl(g,.06,height,[x,height/2,i*.1],C.jade);for(let y=.35;y<height;y+=.5)cyl(g,.076,.05,[x,y,i*.1],C.jadeDark);for(let j=0;j<4;j++){const a=j*1.6+i,origin=[x,height*.6+j*.2,i*.1];const tip=[x+Math.sin(a)*.6,origin[1]+.25,i*.1+Math.cos(a)*.5];beam(g,origin,tip,.02,C.jadeDark);for(let n=0;n<2;n++){const m=ball(g,.22,[tip[0],tip[1]-.03*n,tip[2]],C.leaf,[.35,.25,1.4]);m.rotation.y=a;}}}return g;}
function planter(p,pos){const g=group('Bamboo planter');at(p,g,pos);cyl(g,.45,.52,[0,.26,0],C.cream,.52);ring(g,.5,.035,[0,.52,0],C.woodLight);bamboo(g,[0,.52,0],1.9);return g;}
function lantern(p,pos,attention=false){const g=group(attention?'Needs you lantern':'Paper lantern');at(p,g,pos);beam(g,[0,0,0],[0,-.35,0],.017,C.wood);const glow=new THREE.MeshStandardMaterial({color:attention?C.amber:C.cream,roughness:1,emissive:attention?C.amber:C.cream,emissiveIntensity:attention?.25:.03});ball(g,.27,[0,-.67,0],glow,[1,1.22,1]);for(const y of [-.34,-.98])cyl(g,.15,.04,[0,y,0],C.wood);beam(g,[0,-1,0],[0,-1.2,0],.024,C.red);g.userData.lantern=true;g.userData.attention=attention;return g;}
function lanternPost(p,pos,attention=false){const g=group('Lantern post');at(p,g,pos);cyl(g,.18,.12,[0,.06,0],C.stone);cyl(g,.07,2.8,[0,1.4,0],C.wood);beam(g,[0,2.8,0],[.65,2.8,0],.065,C.wood);lantern(g,[.5,2.77,0],attention);return g;}
function bun(p,pos,s=.17){const g=group('Pleated bao');at(p,g,pos,0,s);ball(g,1,[0,.75,0],C.cream,[1,.7,1]);for(let i=0;i<8;i++){const a=i*Math.PI/4;beam(g,[Math.sin(a)*.6,1.17,Math.cos(a)*.6],[Math.sin(a)*.12,1.49,Math.cos(a)*.12],.048,C.bamboo);}return g;}
function basket(p,pos,r=.45,open=false){const g=group('Bamboo basket');at(p,g,pos);cyl(g,r,.25,[0,.14,0],C.bamboo);for(const y of [.045,.12,.2,.27])ring(g,r,.018,[0,y,0],C.woodLight);for(let i=0;i<24;i++){const a=i*Math.PI/12;beam(g,[Math.sin(a)*r,.04,Math.cos(a)*r],[Math.sin(a)*r,.26,Math.cos(a)*r],.012,C.woodLight);}if(open){for(const x of [-.15,.15])bun(g,[x,.27,0],r*.38);}else{cyl(g,r+.025,.04,[0,.29,0],C.bamboo);for(let z=-r+.04;z<r;z+=.12){const len=2*Math.sqrt(r*r-z*z);box(g,[len,.015,.025],[0,.321,z],C.woodLight,.006);}ball(g,.045,[0,.35,0],C.wood);}return g;}
function plate(p,pos,r=.3){cyl(p,r,.04,pos,C.cream);ring(p,r*.89,.02,[pos[0],pos[1]+.025,pos[2]],C.blue);return bun(p,[pos[0],pos[1]+.022,pos[2]],r*.53);}
function cup(p,pos,c=C.cream){const g=group('Teacup');at(p,g,pos);cyl(g,.09,.12,[0,.06,0],c,.12);cyl(g,.099,.008,[0,.122,0],C.wood);return g;}
function teapot(p,pos,s=1){const g=group('Teapot');at(p,g,pos,0,s);ball(g,.24,[0,.2,0],C.jade,[1,.85,1]);cyl(g,.15,.04,[0,.4,0],C.jade);ball(g,.045,[0,.46,0],C.woodLight);beam(g,[.18,.23,0],[.43,.37,0],.06,C.jade);const handle=mesh(g,new THREE.TorusGeometry(.17,.04,8,24),C.jade,[-.24,.24,0]);return g;}
function bell(p,pos){cyl(p,.17,.04,pos,C.wood);ball(p,.14,[pos[0],pos[1]+.095,pos[2]],C.gold,[1,.65,1]);cyl(p,.022,.08,[pos[0],pos[1]+.21,pos[2]],C.gold);}
function scroll(p,pos,w=.6,h=.55){const g=group('Recipe scroll');at(p,g,pos);box(g,[w,.035,h],[0,0,0],C.cream,.007);for(const x of [-w/2,w/2]){const m=cyl(g,.04,h+.12,[x,.035,0],C.wood);m.rotation.x=Math.PI/2;}for(let i=0;i<4;i++)box(g,[w*.65,.008,.012],[0,.023,-h*.3+i*h*.15],C.wood,.001);return g;}
function bubble(p,text,pos,w=1.3,color=C.cream){const g=group('Activity bubble');at(p,g,pos);box(g,[w,.42,.075],[0,0,0],color,.12);textPlane(g,text,[0,0,.041],w-.12,.3,C.ink,color);const tail=mesh(g,new THREE.ConeGeometry(.08,.15,3),color,[-w*.28,-.26,0]);tail.rotation.z=Math.PI;g.userData.bubble=true;return g;}
function worker(p,role,pos,s=.36,yaw=0,sleep=false){
  if(!residentsOn)return new THREE.Group();
  const rig=createBao(THREE,{detail:'low'}),model=rig.model;at(p,model,pos,yaw,s);rigs.set(model,rig);model.userData.panda=true;model.userData.role=role;
  rig.setSleepiness(sleep?.74:.2);
  const assignedRole=role==='stem-cub'?'stem-cub':role;
  const gear=createTraditionalGear(rig,assignedRole,'traveler');
  model.userData.gearDirection='traveler';model.userData.propName=gear.name;
  model.userData.role=assignedRole;model.userData.repositoryEquipment=true;
  extras.set(model,gear);
  return model;
}
function workbench(p,w=2.8,z=.55,h=1.15){box(p,[w,.16,.8],[0,h,z],C.woodLight);for(const x of [-w*.42,w*.42])box(p,[.14,h-.16,.65],[x,(h-.16)/2+.08,z],C.wood);box(p,[w,.4,.12],[0,h-.28,z+.35],C.wood);}

function team(kind){
  const g=group(kind+' pavilion');const color={steamers:C.blue,tea:C.jade,pantry:C.jadeDark,front:C.red}[kind];
  pavilion(g,4.1,3,3.35,color);const names={steamers:'STEAMERS',tea:'TEA & TASTING',pantry:'THE PANTRY',front:'PLATING STUDIO'};sign(g,names[kind],[0,2.85,1.1],2.6,color);
  workbench(g,3,.65);lantern(g,[1.62,3.14,.85]);
  if(kind==='steamers'){
    for(const x of [-1,1])for(let i=0;i<(x<0?3:2);i++)basket(g,[x,1.24+i*.32,.65],.37,i===2);
    bun(g,[0,1.25,.85],.19);box(g,[.65,.04,.45],[0,1.25,.75],C.bamboo);worker(g,'developer',[0,.43,-.05],.38);if(residentsOn)bubble(g,'Folding a fix',[0,2.37,.55],1.55);
  }else if(kind==='tea'){
    box(g,[1.5,.06,.55],[.6,1.27,.68],C.jade);teapot(g,[.6,1.32,.65]);for(const x of [.1,1.15])cup(g,[x,1.32,.7]);worker(g,'qa',[-.55,.43,-.05],.37);if(residentsOn)bubble(g,'Tasting the batch',[-.55,2.28,.45],1.7);
  }else if(kind==='pantry'){
    box(g,[1.15,1.6,.5],[1,1.05,-.83],C.wood);for(const y of [.5,1,1.5])box(g,[1.02,.06,.52],[1,y,-.83],C.woodLight);for(const x of [.7,1.3])for(const y of [.72,1.2])cyl(g,.15,.25,[x,y,-.65],C.cream);worker(g,'security',[-.6,.43,-.05],.37);box(g,[.42,.04,.35],[.3,1.25,.7],C.cream);cyl(g,.12,.2,[.3,1.37,.7],C.red);if(residentsOn)bubble(g,'Checking the seal',[-.6,2.28,.5],1.8);
  }else{
    worker(g,'designer',[-.52,.43,-.05],.37);for(const x of [-.9,0,.9])plate(g,[x,1.26,.74],.29);const pen=beam(g,[.3,1.3,.5],[.75,1.32,.8],.025,C.ink);if(residentsOn)bubble(g,'Making it lovely',[-.52,2.3,.45],1.7);
  }
  return g;
}
function baoPass(){const g=group('Bao’s welcoming Pass');roundPad(g,3.2);worker(g,'orchestrator',[0,.16,-.6],1.14);workbench(g,3.8,2,1.15);bell(g,[1.1,1.25,2]);scroll(g,[-.7,1.25,2],1,.55);plate(g,[.3,1.25,2],.35);for(const x of [-1.6,1.6])cyl(g,.08,2.7,[x,1.5,1.75],C.wood);beam(g,[-1.6,2.8,1.75],[1.6,2.8,1.75],.055,C.wood);for(let i=0;i<5;i++){box(g,[.32,.5,.025],[-1.15+i*.57,2.5,1.75],C.cream,.008);cyl(g,.03,.055,[-1.15+i*.57,2.8,1.75],C.gold);}sign(g,'BAO · THE PASS',[0,.58,2.4],2.5,C.jade);planter(g,[-2.5,.15,0]);planter(g,[2.5,.15,0]);return g;}
function meeting(){const g=group('Round-table pavilion');roundPad(g,2.8);pavilion(g,5.4,4.8,3.9,C.jade);cyl(g,.22,1.1,[0,.7,0],C.wood);cyl(g,1.4,.15,[0,1.25,0],C.woodLight);cyl(g,.8,.08,[0,1.37,0],C.bamboo);scroll(g,[0,1.43,0],.7,.5);for(let i=0;i<6;i++){const a=i*Math.PI/3,x=Math.sin(a)*2,z=Math.cos(a)*2;stool(g,[x,.17,z],[C.jade,C.blue,C.red][i%3]);cup(g,[Math.sin(a)*1.08,1.34,Math.cos(a)*1.08]);}sign(g,'THE ROUND TABLE',[0,3.4,1.8],2.6,C.jade);return g;}
function library(){const g=group('Recipe library');pavilion(g,4,3,3.3,C.lavender);sign(g,'RECIPE LIBRARY',[0,2.83,1.08],2.5,C.jadeDark);for(const x of [-1.35,1.35]){box(g,[.6,2.2,.65],[x,1.3,-.65],C.wood);for(const y of [.45,1.1,1.75,2.4])box(g,[.65,.08,.7],[x,y,-.65],C.woodLight);for(let j=0;j<7;j++){const color=[C.jade,C.cream,C.red,C.lavender][j%4];box(g,[.055,.42,.25],[x-.22+j*.073,.71,-.42],color,.012);box(g,[.055,.42,.25],[x-.22+j*.073,1.36,-.42],color,.012);}}
  bench(g,1.8,[0,.22,.4]);for(const x of [-.6,.2])cushion(g,[x,.95,.4],C.lavender,.6);scroll(g,[.3,1.08,.4]);box(g,[2.3,.14,.5],[0,.2,1.4],C.stone);return g;}
function study(){const g=group('Quiet study nook');roundPad(g,1.8);const awning=box(g,[2.8,.12,1.8],[0,2.9,-.15],C.cream);awning.rotation.z=-.1;for(const x of [-1.1,1.1])cyl(g,.06,2.9,[x,1.5,-.75],C.wood);workbench(g,1.8,-.25,.96);scroll(g,[-.35,1.08,-.25],.7,.5);cup(g,[.5,1.05,-.25]);cushion(g,[0,.31,.75],C.lavender,.95);bamboo(g,[-1.5,.1,-.35],3.3);lantern(g,[1.1,2.8,0]);return g;}
function connector(){const g=group('Bamboo connector cabinet');floor(g,2.8,2.2);box(g,[1.8,2.3,.65],[0,1.4,-.3],C.wood);box(g,[1.65,2.08,.075],[0,1.4,.05],C.jadeDark);for(let i=0;i<4;i++){box(g,[1.4,.29,.13],[0,2.12-i*.44,.15],C.cream);ball(g,.047,[-.48,2.12-i*.44,.23],i===3?C.stone:C.jade);textPlane(g,['REPO','TOOLS','SKILLS','UNLINKED'][i],[.1,2.12-i*.44,.223],.9,.16,C.ink,C.cream);}roof(g,2.8,1.9,2.7);sign(g,'CONNECTIONS',[0,.38,.52],1.8,C.jade);tube(g,[[.8,.5,-.3],[1.05,.4,.15],[1,.3,.8]],.035,C.wood);planter(g,[-1.07,.2,.45]);return g;}
function skills(){const g=group('Practice garden');roundPad(g,2);beam(g,[-1.6,.15,-1],[ -1.6,2.7,-1],.09,C.bamboo);beam(g,[1.6,.15,-1],[1.6,2.7,-1],.09,C.bamboo);beam(g,[-1.85,2.7,-1],[1.85,2.7,-1],.1,C.wood);sign(g,'PRACTICE GARDEN',[0,2.3,-.9],2.4,C.jade);for(let i=0;i<3;i++){const x=(i-1)*1;box(g,[.65,.35,.65],[x,.35,.25],C.woodLight);basket(g,[x,.54,.25],.26,i===2);}scroll(g,[0,.75,.25],.4,.3);bamboo(g,[-1.7,.1,.6],2);return g;}
function trolley(){const g=group('Dumpling handoff trolley');for(const y of [.55,1.18])box(g,[1.5,.1,.85],[0,y,0],C.woodLight);for(const x of [-.63,.63])for(const z of [-.3,.3]){beam(g,[x,.2,z],[x,1.2,z],.045,C.wood);const wheel=cyl(g,.17,.1,[x,.18,z],C.jadeDark);wheel.rotation.z=Math.PI/2;}beam(g,[-.74,1.1,-.35],[-.74,1.5,-.35],.05,C.wood);beam(g,[-.74,1.5,-.35],[-.74,1.5,.35],.05,C.wood);basket(g,[-.38,1.24,0],.3,true);basket(g,[.37,1.24,0],.3);basket(g,[.35,.61,0],.34);return g;}
function abacus(){const g=group('Kitchen tally abacus');floor(g,2.3,1.2);for(const x of [-.95,.95])box(g,[.15,2.2,.15],[x,1.3,0],C.wood);for(const y of [.35,2.3])box(g,[2.05,.15,.2],[0,y,0],C.wood);const counts=[6,4,3,2,1],rows=[];for(let i=0;i<5;i++){const y=1.94-i*.32,beads=[];rows.push(beads);beam(g,[-.92,y,0],[.92,y,0],.02,C.woodLight);for(let j=0;j<10;j++){const x=-.77+j*.17;beads.push(ball(g,.077,[x,y,0],new THREE.MeshStandardMaterial({color:j<counts[i]?[C.jade,C.jade,C.blue,C.gold,C.red][i]:C.bamboo,roughness:.88}),[.7,1,1]));}textPlane(g,['5 H','WEEK','SLOTS','SERVED','SPILLS'][i],[1.35,y,.01],.6,.15,C.ink,C.cream);}sign(g,'KITCHEN TALLY',[0,2.66,.04],1.9,C.jade);g.userData.tally={rows};return g;}
function rail(){const g=group('Order-slip rail');for(const x of [-1.35,1.35]){cyl(g,.07,2.2,[x,1.1,0],C.wood);cyl(g,.2,.12,[x,.06,0],C.stone);}beam(g,[-1.4,2,0],[1.4,2,0],.045,C.bamboo);for(let i=0;i<5;i++){box(g,[.38,.68,.04],[-1.08+i*.54,1.62,0],C.cream,.018);box(g,[.29,.06,.046],[-1.08+i*.54,1.83,.025],[C.jade,C.blue,C.lavender][i%3]);for(let j=0;j<3;j++)box(g,[.25,.018,.012],[-1.08+i*.54,1.66-j*.12,.028],C.wood);ball(g,.035,[-1.08+i*.54,1.99,.03],C.gold);}sign(g,'ORDER RAIL',[0,.85,0],1.7,C.jade);return g;}
function baskets(){const g=group('Ticket baskets');for(let i=0;i<3;i++)basket(g,[-.55,.02+i*.31,0],.43);basket(g,[.5,.02,.05],.45,true);box(g,[.32,.42,.025],[-.55,.61,.44],C.cream);textPlane(g,'NEXT',[-.55,.64,.455],.25,.13,C.ink,C.cream);return g;}
function dishes(){const g=group('Tea & dim sum service');box(g,[1.75,.07,1.2],[0,.05,0],C.wood);teapot(g,[-.48,.12,-.28]);for(const pos of [[-.65,.12,.36],[.5,.12,-.32]])cup(g,pos);plate(g,[.35,.13,.3],.35);for(const x of [.88,.94])beam(g,[x,.14,-.15],[x,.14,.5],.016,C.woodLight);return g;}
function request(){const g=group('Needs you attention kit');lanternPost(g,[-.3,0,0],true);box(g,[.7,.7,.55],[.5,.37,.35],C.wood);bell(g,[.5,.76,.35]);bubble(g,'Needs you',[.05,3.14,.15],1.3,C.amber);return g;}
function states(){const g=group('Panda activity & state kit');const items=[['Reading',C.cream],['Working',C.cream],['Needs you',C.amber],['Blocked',C.stone],['Done ✓',C.cream],['Failed !',C.red]];for(let i=0;i<6;i++){const x=(i%3-1)*1.65,y=1.5-Math.floor(i/3)*.85;bubble(g,items[i][0],[x,y,0],1.42,items[i][1]);}return g;}
function crew(){const g=group('The resident crew');const roles=Object.keys(TRADITIONAL_PROPS);roles.forEach((role,i)=>{const x=(i%4-1.5)*2.6,z=(Math.floor(i/4)-1.5)*3;worker(g,role,[x,0,z],.36);textPlane(g,role.toUpperCase(),[x,.1,z+1.0],2.3,.2,C.ink,C.cream).rotation.x=-Math.PI/2;});return g;}
function teaRetreat(){const g=group('Garden tea retreat');roundPad(g,1.85);cyl(g,.12,.66,[0,.46,0],C.wood);cyl(g,.76,.12,[0,.83,0],C.woodLight);teapot(g,[0,.92,0]);for(const x of [-.8,.8]){cushion(g,[x,.28,.95],C.jade,.8);cup(g,[x*.6,.92,.32]);}bamboo(g,[-1.1,.15,-.8],3.2);bamboo(g,[1.1,.15,-.8],2.7);return g;}
function mahjong(){const g=group('Mahjong corner');roundPad(g,2.1);box(g,[1.65,.18,1.65],[0,.85,0],C.wood);box(g,[1.48,.025,1.48],[0,.96,0],C.jade);for(const x of [-.65,.65])for(const z of [-.65,.65])box(g,[.12,.7,.12],[x,.45,z],C.wood);for(let side=0;side<4;side++)for(let j=0;j<8;j++){const tile=group('Mahjong tile');at(g,tile,[0,1.03,0],side*Math.PI/2);box(tile,[.12,.16,.07],[-.52+j*.15,0,.58],C.cream,.018);ball(tile,.018,[-.52+j*.15,.02,.619],j%2?C.red:C.jade);}for(const [x,z]of [[0,1.5],[0,-1.5],[-1.5,0],[1.5,0]])stool(g,[x,.15,z],C.jade);return g;}
function rest(){const g=group('Sleepy cushion nook');floor(g,3.4,2.4);for(const x of [-1.3,1.3])cyl(g,.08,2.7,[x,1.45,-.7],C.wood);beam(g,[-1.5,2.75,-.7],[1.5,2.75,-.7],.08,C.wood);box(g,[2.9,.12,1.9],[0,2.8,-.1],C.bamboo).rotation.x=.12;cushion(g,[-.55,.36,.3],C.lavender,1.05);cushion(g,[.7,.36,.3],C.cream,.95);worker(g,'cub',[-.55,.46,.2],.26,0,true);if(residentsOn)bubble(g,'zzz',[-.55,1.73,.28],.65);box(g,[2.8,.5,.12],[0,.55,-.88],C.woodLight);return g;}
function grove(){const g=group('Bamboo & garden planting');for(const [x,z,h]of [[-1.2,.4,3.5],[0,-.4,4.3],[1.2,.3,3]])bamboo(g,[x,0,z],h,x);for(const x of [-1.1,.6,1.3])ball(g,.38,[x,.12,.8],C.stone,[1,.55,.7]);for(let i=0;i<6;i++)ball(g,.28,[Math.sin(i*2.3)*1.5,.13,Math.cos(i*2.3)*1.2],C.leaf,[1,.6,1]);return g;}
function gate(){const g=group('Welcome garden gate');for(const x of [-1.7,1.7]){cyl(g,.15,3.1,[x,1.55,0],C.wood);cyl(g,.22,.2,[x,.1,0],C.stone);}roof(g,4.4,1.6,3.1);sign(g,'DIM SUM DEV',[0,2.65,.22],2.8,C.jade);lantern(g,[-1.4,2.76,.3]);lantern(g,[1.4,2.76,.3]);return g;}
function paths(){const g=group('Courtyard paving kit');for(let i=0;i<7;i++){const m=cyl(g,.56,.1,[(i-3)*.9,.05,Math.sin(i)*.2],C.stone);m.scale.z=.7;m.rotation.y=i*.4;}for(const x of [-2.4,2.4])ball(g,.16,[x,.1,.6],C.leaf,[1,.5,1]);return g;}
function buildPad(){const g=group('Future workspace plot');roundPad(g,1.5,C.grass);for(const x of [-1.1,1.1])for(const z of [-1.1,1.1]){cyl(g,.05,.6,[x,.3,z],C.wood);box(g,[.2,.2,.035],[x,.48,z],C.cream);}for(const z of [-1.1,1.1])beam(g,[-1.1,.43,z],[1.1,.43,z],.015,C.bamboo);for(const x of [-1.1,1.1])beam(g,[x,.43,-1.1],[x,.43,1.1],.015,C.bamboo);sign(g,'ROOM TO GROW',[0,.8,1.25],1.85,C.jadeDark);return g;}

export const ASSETS=[
 ['bao','Bao & the Pass','Chef’s porch','Work & coordination',baoPass,'A welcoming place to talk to Bao, with order slips, a service bell and dishes ready for service.','Existing identity · chief-of-staff dressing proposed'],
 ['steamers','Steamers workshop','Developer & scout','Work & coordination',()=>team('steamers'),'Bamboo baskets, a generous prep counter and a panda folding the next fix.','Existing team · new furniture study'],
 ['tea','Tea & tasting bar','Quality assurance','Work & coordination',()=>team('tea'),'A calm tasting bench where the batch is checked before it moves on.','Existing team · new furniture study'],
 ['pantry','The Pantry','Security & seals','Work & coordination',()=>team('pantry'),'A tidy pantry, ingredient shelves and a seal stamp give security its own recognizable place.','Existing team · new furniture study'],
 ['front','Plating studio','Designer & herald','Work & coordination',()=>team('front'),'A creative workbench for polishing the final dish, menus and draft scrolls.','Existing team · new furniture study'],
 ['meeting','Round-table pavilion','Six places to gather','New workspace ideas',meeting,'A shared lazy susan, six movable seats and a central decision scroll. Open sides preserve the view into the meeting.','Accepted meeting concept · scene treatment proposed'],
 ['library','Recipe library','Decisions & memory','New workspace ideas',library,'An open recipe archive with shelves, rolled recipes, reading steps and a cushioned bench.','Proposed knowledge workspace'],
 ['study','Quiet study nook','A little room to think','New workspace ideas',study,'A canopy, scroll desk and floor cushion tucked into bamboo. A quieter alternative to the bustling kitchen.','Proposed scenery'],
 ['connector','Connector cabinet','Tools & connection cues','New workspace ideas',connector,'A bamboo-framed service cabinet turns tool connections into legible scenery, with a separate indicator per connection.','Video-inspired proposal · sample indicators'],
 ['skills','Practice garden','Learn by making','New workspace ideas',skills,'A miniature training garden with practice baskets and a recipe scroll. Small challenges, repeatable habits.','Existing training idea · functional dressing proposed'],
 ['trolley','Handoff trolley','Carry the next dish','Props & signals',trolley,'A two-tier bamboo trolley carries baskets between teams. The handoff stays tangible and on-theme.','Proposed reusable handoff prop'],
 ['abacus','Kitchen tally','Budget & capacity','Props & signals',abacus,'A wooden abacus holds five rods: the current window, weekly usage, slots, served work and spills.','Existing tally idea · illustrative values'],
 ['rail','Order-slip rail','Work waiting to happen','Props & signals',rail,'Clipped paper orders make the queue visible without filling the garden with floating panels.','Existing order-slip metaphor'],
 ['baskets','Ticket baskets','Next & in progress','Props & signals',baskets,'Closed baskets wait their turn; an open basket reveals the work inside. A next-order tag gives the stack direction.','Existing ticket-basket metaphor'],
 ['dishes','Tea & dim sum set','The small details','Props & signals',dishes,'A matte ceramic teapot, two cups, a pleated bao and chopsticks on a rounded wooden tray.','Reusable scenery props'],
 ['request','Needs you kit','Lantern, bell & bubble','Props & signals',request,'A bright amber lantern, service bell and explicit label mark a request. Ordinary paper lanterns remain quieter cream.','Existing attention language · geometry study'],
 ['states','Activity bubble kit','Six readable states','Props & signals',states,'Labels and shapes accompany the palette: Reading, Working, Needs you, Blocked, Done and Failed.','Existing state and tool-bubble goals'],
 ['crew','Resident panda crew','Fourteen repository characters','Props & signals',crew,'Current traditional headwear, sashes and role props on the repository plush rig. Nine live roles plus five character concepts; individual views identify the future concepts.','Reused from main · not new character art'],
 ['retreat','Garden tea retreat','Between the busy moments','Life in the den',teaRetreat,'A low tea table with floor cushions in a pocket of bamboo. A place for resident pandas to pause.','Existing leisure direction'],
 ['mahjong','Mahjong corner','A friendly little break','Life in the den',mahjong,'A jade felt table, rounded stools and tiny ceramic tiles add life between jobs.','Existing leisure direction'],
 ['rest','Sleepy cushion nook','Clocked out, still at home','Life in the den',rest,'A soft canopy covers cushions and a dozing cub. It reads as rest without looking abandoned.','Existing leisure direction · canopy proposed'],
 ['grove','Bamboo planting kit','A soft garden edge','Life in the den',grove,'Jointed bamboo, jade leaves, soft shrubs and rounded stones make a consistent garden vocabulary.','Reusable environment kit'],
 ['gate','Garden welcome gate','A sense of arrival','Life in the den',gate,'A low upturned roof and two quiet paper lanterns frame the entrance to the den.','Proposed scenery'],
 ['paths','Courtyard paving','Room to walk','Life in the den',paths,'Broad stepping stones connect the pavilions and leave space for pandas to carry work between them.','Existing walkable-layout goal'],
 ['pad','Future workspace plot','Room to grow','Life in the den',buildPad,'An empty marked garden plot leaves a clear place for a team that does not exist yet.','Existing build-pad direction'],
].map(([id,name,subtitle,category,build,description,basis],index)=>({id,name,subtitle,category,build,description,basis,index:index+1}));

export function createAsset(id,{includeResidents=true}={}){const asset=ASSETS.find(x=>x.id===id);if(!asset)throw new Error(`Unknown asset: ${id}`);const before=residentsOn;residentsOn=includeResidents;try{const root=asset.build();root.userData.assetId=id;return root;}finally{residentsOn=before;}}

// Where each kit asset stands in the assembled den (renders/layout-top.png).
export const VILLAGE_POSITIONS={bao:[0,0,-10],steamers:[-14,0,-10],tea:[-14,0,0],pantry:[14,0,0],front:[14,0,-10],meeting:[0,0,9],library:[0,0,-20],study:[-10,0,-20],connector:[14,0,-19],skills:[14,0,18],trolley:[-9,0,-10],abacus:[18,0,10],rail:[-19,0,-10],baskets:[-19,0,-5],dishes:[-10,.77,18],request:[14,0,10],states:[0,0,0],crew:[0,0,0],retreat:[-14,0,10],mahjong:[-9,0,19],rest:[4,0,20],grove:[-23,0,-10],gate:[0,0,25],paths:[0,0,23],pad:[-19,0,-17]};
// The two promenades, the crosspaths and the short team approaches, as [x,z] polylines.
export const VILLAGE_PATHS=(()=>{
  const s=[[[-7,-16],[-7,21]],[[7,-16],[7,21]],[[-7,-16],[7,-16]],[[-7,-5],[7,-5]],[[-7,4],[7,4]],[[-7,15],[7,15]],[[-7,23],[7,23]],[[0,23],[0,25]],[[0,-16],[0,-13.4]],[[0,-16],[0,-18]],[[0,4],[0,5.2]],[[0,13],[0,15]],[[7,21],[7,23]],[[-7,21],[-7,23]]];
  for(const z of [-10,0,10,19])s.push([[-7,z],[-11,z]],[[7,z],[11,z]]);
  s.push([[-7,-16],[-10,-16]],[[-10,-16],[-10,-18]],[[7,-16],[14,-16]],[[14,-16],[14,-17]]);
  return s;
})();
/** The assembled den. includeResidents:false leaves out the kit's illustrative pandas (den-mvp/25): the den's actors own the live ones. */
export function createVillage({includeResidents=true}={}){
  const before=residentsOn;residentsOn=includeResidents;
  try{return buildVillage(includeResidents);}finally{residentsOn=before;}
}
function buildVillage(includeResidents){
  const world=group('Dim Sum Dev · garden village');
  const ground=cyl(world,28,.55,[0,-.34,0],C.grass);ring(world,27.7,.16,[0,-.08,0],C.leaf);
  const lawn=cyl(world,27,.05,[0,-.04,0],C.grass);lawn.receiveShadow=true;
  const positions=VILLAGE_POSITIONS;
  for(const a of ASSETS){if(['crew','states','dishes','paths'].includes(a.id))continue;const root=createAsset(a.id,{includeResidents});const yaw=0;at(world,root,positions[a.id],yaw);root.userData.selectable=true;}
  // Remaining kit pieces are distributed naturally instead of dumping a separate sample board in the village.
  const serving=group('Courtyard snack table');cyl(serving,.1,.65,[0,.42,0],C.wood);cyl(serving,.8,.12,[0,.8,0],C.woodLight);at(serving,createAsset('dishes',{includeResidents}),[0,.89,0],0,.65);at(world,serving,[-12.8,0,19]);
  worker(world,'product',[-2.9,.05,-10],.36,.35);worker(world,'architect',[2.9,.05,-10],.36,-.3);worker(world,'scout',[-12,.05,-7],.34,.3);worker(world,'herald',[12,.05,-8],.34,-.3);
  worker(world,'qa',[-14,.15,10],.29,.2);worker(world,'designer',[-9,.15,20.7],.29,0);worker(world,'security',[12,.15,18],.28,-.3);
  // Two continuous promenades, crosspaths and short perpendicular team approaches.
  const segments=VILLAGE_PATHS;
  for(const [a,b] of segments){const length=Math.hypot(b[0]-a[0],b[1]-a[1]),n=Math.ceil(length/.85);for(let i=0;i<n;i++){const t=i/n;const m=cyl(world,.43,.05,[a[0]+(b[0]-a[0])*t,.005,a[1]+(b[1]-a[1])*t],C.stone);m.scale.z=.85;}}
  // Intentionally low planting around the front; taller bamboo frames the back silhouette.
  for(let i=0;i<28;i++){const a=Math.PI*.53+i*Math.PI*.94/27;const x=Math.sin(a)*26,z=Math.cos(a)*26;if(z<4)bamboo(world,[x,0,z],2.7+(i%4)*.35,a);}
  for(let i=0;i<48;i++){const a=i*Math.PI*2/48,x=Math.sin(a)*26.8,z=Math.cos(a)*26.8;if(Math.abs(x)<2&&z>10)continue;ball(world,.3+(i%3)*.1,[x,.14,z],i%4?C.leaf:C.stone,[1.1,.55,.9]);}
  for(const p of [[-7.9,0,4],[7.9,0,4],[-7.9,0,15],[7.9,0,15],[-3,0,24],[3,0,24]])lanternPost(world,p);
  // Name markers are optional and can be turned off for an uncluttered beauty render.
  for(const [id,title]of [['bao','01  BAO & THE PASS'],['steamers','02  STEAMERS'],['front','05  PLATING'],['meeting','06  ROUND TABLE'],['tea','03  TEA'],['pantry','04  PANTRY'],['library','07  RECIPES'],['study','08  QUIET STUDY']]){
    const pos=positions[id],marker=group('Overview label');marker.userData.overviewLabel=true;at(world,marker,[pos[0],.08,pos[2]+(id==='bao'?3.1:2)]);textPlane(marker,title,[0,0,0],id==='bao'?3.5:3,.42,C.jadeDark,C.cream).rotation.x=-Math.PI/2;
  }
  world.userData.assembled=true;return world;
}

export function animateAssets(root,time,motion){root.traverse(o=>{const rig=rigs.get(o);if(rig){const role=o.userData.role;if(motion){rig.bones.Head.rotation.x=Math.sin(time*.8)*.025;rig.bones.Torso.scale.y=1+Math.sin(time*1.1)*.009;if(['developer','designer','herald'].includes(role))rig.bones.Wrist_R.rotation.z=Math.sin(time*2)*.09;rig.setSleepiness(role==='stem-cub'?.74:.2+Math.pow(Math.max(0,Math.cos(time*1.4)),24)*.5);}else{rig.bones.Head.rotation.x=0;rig.bones.Torso.scale.y=1;rig.bones.Wrist_R.rotation.z=0;rig.setSleepiness(role==='stem-cub'?.74:.2);}}});}
export function setLabels(root,visible){root.traverse(o=>{if(o.userData.overviewLabel)o.visible=visible;});}
export function disposeAsset(root){const geometries=new Set(),mats=new Set(),textures=new Set(),skels=new Set();root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.skeleton)skels.add(o.skeleton);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){if(![...materials.values()].includes(m)){mats.add(m);if(m.map)textures.add(m.map);if(m.normalMap)textures.add(m.normalMap);}}});for(const g of geometries)g.dispose();for(const m of mats)m.dispose();for(const t of textures)t.dispose();for(const s of skels)s.dispose();}

// Exposed only in this separate review kit, to keep the second study visually consistent.
export const KIT={group,mesh,box,cyl,ball,ring,beam,tube,at,textPlane,sign,floor,roundPad,cushion,stool,bench,roof,pavilion,bamboo,planter,lantern,lanternPost,bun,basket,plate,cup,teapot,bell,scroll,bubble,worker,workbench,mat,rigFor:model=>rigs.get(model),gearFor:model=>extras.get(model)};
