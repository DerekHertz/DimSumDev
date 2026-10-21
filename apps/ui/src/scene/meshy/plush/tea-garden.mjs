import {createKoi} from '../koi.mjs';
import * as T from 'three';
import { gardenKit } from './garden-kit.mjs';
export function createTeaGarden(){
  const k=gardenKit('The leaf-shade tea garden'),{root,group,mesh,box,cyl,orb,ring,beam,tube,sign,lantern,bamboo,teaSet,flowers,bao}=k;
  root.userData.assetId='tea-garden-study';
  const ground=group('Soft garden island and wandering stones');
  const base=cyl(ground,1,.22,[0,.03,0],'honey');base.scale.set(5.0,1,3.9);
  const grass=cyl(ground,1,.08,[0,.17,0],'grass');grass.scale.set(4.94,1,3.84);
  for(const[x,z,r]of[[-.9,3.15,.34],[-1.0,2.45,.31],[-1.35,1.85,.30],[.3,2.7,.29],[3.6,2.75,.26]]){
    const stone=cyl(ground,r,.10,[x,.245,z],'stone');stone.scale.z=.76;stone.rotation.y=x*.3;
  }
  for(const side of[-1,1]){orb(ground,.55,[side*3.7,.28,-2.25],'jadeLight',[1.1,.45,1]);flowers(ground,[side*3.6,.25,-2.3],side<0?'pink':'coral',.9);}
  const deck=group('Tea terrace and rounded serving table');
  box(deck,[4.35,.16,3.65],[-1.8,.28,-.55],'timber',.10);
  for(let i=0;i<12;i++)box(deck,[.342,.07,3.5],[-3.7+i*.346,.395,-.55],i%4?'honey':'paleWood',.012);
  box(deck,[2.55,.14,1.0],[-1.65,1.18,.02],'paleWood',.065);
  for(const x of[-2.67,-.63])for(const z of[-.27,.31])cyl(deck,.05,.69,[x,.79,z],'timber');
  box(deck,[1.65,.06,.49],[-1.65,.74,-.03],'honey');
  teaSet(deck,[-1.65,1.265,0],1.15);
  // A biscuit plate, bamboo canister, and little folded cloth make a lived-in tea service.
  cyl(deck,.19,.025,[-.69,1.27,.02],'cream');for(const[dx,dz]of[[-.06,-.03],[.06,-.03],[0,.07]])orb(deck,.065,[-.69+dx,1.315,.02+dz],'gold',[1,.4,1]);
  cyl(deck,.12,.31,[-2.63,1.42,-.07],'jade');cyl(deck,.125,.035,[-2.63,1.59,-.07],'honey');
  box(deck,[.44,.035,.34],[-2.42,1.276,.23],'coral',.015);
  for(const[x,z,color]of[[-2.9,1.0,'coral'],[-.30,1.0,'jadeLight']]){
    cyl(deck,.41,.13,[x,.52,z],'timber');box(deck,[.73,.15,.67],[x,.65,z],color,.1);
    const stitch=ring(deck,.25,.008,[x,.729,z],'cream');stitch.rotation.x=Math.PI/2;
  }
  const teaShelf=group('Tea leaves, cups, and a handwritten welcome',deck,[-3.45,.43,-1.52]);
  for(const y of[.20,.83,1.43])box(teaShelf,[.72,.08,.42],[0,y,0],'paleWood');
  for(const x of[-.31,.31])box(teaShelf,[.07,1.48,.39],[x,.74,0],'timber');
  for(const[x,y,color]of[[-.16,.38,'jade'],[.15,.38,'coral'],[-.14,1.02,'cream'],[.15,1.02,'jade']]){cyl(teaShelf,.09,.22,[x,y,0],color);cyl(teaShelf,.095,.025,[x,y+.12,0],'honey');}
  sign(teaShelf,'TAKE A BREATHER',[0,1.69,.02],1.65);

  const shade=group('Giant lotus-leaf parasol and curved bamboo stem');
  tube(shade,[[-3.48,.22,-1.78],[-3.40,2.60,-1.70],[-2.92,3.45,-1.25],[-1.70,3.70,-.65]],.065,'jadeDeep',40);
  for(const y of[.68,1.18,1.68,2.18])cyl(shade,.079,.03,[-3.45,y,-1.76],'honey');
  const centre=[-1.70,3.67,-.65],radial=20,angular=80,vertices=[],indices=[];
  const leafAt=(a,t)=>{const r=(2.17+.13*Math.sin(a*8))*t;return[centre[0]+Math.cos(a)*r,centre[1]-.40*t**1.6+.035*Math.sin(a*8)*t,centre[2]+Math.sin(a)*r];};
  for(let i=0;i<=radial;i++)for(let j=0;j<=angular;j++){vertices.push(...leafAt(j/angular*Math.PI*2,i/radial));if(i<radial&&j<angular){const v=i*(angular+1)+j;indices.push(v,v+angular+1,v+1,v+1,v+angular+1,v+angular+2);}}
  const leafGeometry=new T.BufferGeometry();leafGeometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));leafGeometry.setIndex(indices);leafGeometry.computeVertexNormals();const leafMaterial=k.materials.jade.clone();leafMaterial.side=T.DoubleSide;mesh(shade,leafGeometry,leafMaterial);
  for(let i=0;i<16;i++)tube(shade,Array.from({length:20},(_,j)=>{const p=leafAt(i/16*Math.PI*2,.03+j/19*.97);p[1]+=.014;return p;}),i%2?.012:.019,'jadeLight',24);
  tube(shade,Array.from({length:81},(_,i)=>leafAt(i/80*Math.PI*2,1)),.024,'jadeDeep',80);
  orb(shade,.15,[centre[0],centre[1]+.04,centre[2]],'jadeLight',[1,.35,1]);lantern(shade,[-2.95,3.28,-.72],.62);

  const pond=group('Koi pond, lotus leaves, and curved timber bridge');
  const rim=ring(pond,1.58,.085,[2.18,.26,.75],'stone');rim.rotation.x=Math.PI/2;rim.scale.set(1.12,.94,1);
  const bottom=cyl(pond,1,.025,[2.18,.19,.75],'blueDeep');bottom.scale.set(1.72,1,1.43);
  const waterMaterial=new T.MeshStandardMaterial({color:'#9bc9cb',roughness:.30,transparent:true,opacity:.72,depthWrite:false});
  const water=mesh(pond,new T.CircleGeometry(1,80),waterMaterial,[2.18,.252,.75]);water.rotation.x=-Math.PI/2;water.scale.set(1.72,1.43,1);
  for(const[x,z,r]of[[1.05,.55,.27],[2.75,-.13,.31],[3.05,1.22,.24]]){
    const shape=new T.Shape();shape.moveTo(0,0);shape.absarc(0,0,r,.20,Math.PI*2-.20,false);shape.lineTo(0,0);const pad=mesh(pond,new T.ShapeGeometry(shape,32),'jade',[x,.275,z]);pad.rotation.x=-Math.PI/2;
    beam(pond,[x,.28,z],[x+r*.65,.28,z],.007,'jadeLight');
  }
  const lotus=group('A tiny pink lotus',pond,[2.73,.30,-.12]);
  for(let i=0;i<7;i++){const a=i/7*Math.PI*2,p=orb(lotus,.08,[Math.cos(a)*.065,.025,Math.sin(a)*.065],'pink',[.6,.6,1.25]);p.rotation.y=a+Math.PI/2;}orb(lotus,.045,[0,.07,0],'gold');
  const bridgeY=t=>.31+.42*Math.sin(t*Math.PI);
  for(let i=0;i<17;i++){
    const t=(i+.5)/17,x=.28+t*3.88,slat=box(pond,[.214,.075,.80],[x,bridgeY(t),1.18],'paleWood',.012);slat.rotation.z=Math.atan(.42*Math.PI/3.88*Math.cos(t*Math.PI));
  }
  for(const z of[.72,1.64]){
    tube(pond,Array.from({length:31},(_,i)=>{const t=i/30;return[.28+t*3.88,bridgeY(t)+.45,z];}),.035,'honey',32);
    for(let i=0;i<=4;i++){const t=i/4,x=.28+t*3.88;beam(pond,[x,bridgeY(t),z],[x,bridgeY(t)+.45,z],.025,'jadeDeep');orb(pond,.042,[x,bridgeY(t)+.47,z],'gold');}
  }
  // A shy frog and its tiny leaf umbrella live by the pond.
  const frog=group('Easter egg — pond frog with a leaf parasol',pond,[3.86,.30,-.15]);
  orb(frog,.095,[0,0,0],'jadeDeep',[1.2,.8,1]);for(const x of[-.05,.05]){orb(frog,.037,[x,.075,.045],'jade');orb(frog,.012,[x,.087,.072],'ink');}beam(frog,[.08,0,0],[.08,.27,0],.008,'timber');orb(frog,.15,[.08,.27,0],'jade',[1,.10,.8]);
  bamboo(root,[-4.0,.21,1.7],.85);bamboo(root,[3.7,.21,-2.45],1.0,false);flowers(root,[.4,.21,-2.7],'pink',1.1);bao(root,[-.1,.35,2.25],.7);
  k.finish();
  const koi=createKoi(k,pond);
  return{root,shade,pond,waterSurface:pond.children.find(m=>m.material===waterMaterial),koi,dispose:k.dispose,setShadeVisible(v){shade.visible=v;},
    residents:[{id:'tea-host',position:[-1.45,.445,-1.5],yaw:.18,color:'#709b86',pose:'standing'},{id:'tea-guest',position:[-.42,.445,1.12],yaw:-.5,color:'#c68f7d',pose:'seated'}],
    views:{overview:{position:[10.5,8.9,13.8],target:[0,1.7,.15],shade:true},detail:{position:[6.5,6.0,7.4],target:[1.6,.65,.65],shade:false},approach:{position:[-5.6,3.5,6.7],target:[-1.5,1.2,-.2],shade:true}}};
}
