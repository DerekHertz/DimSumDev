import * as T from 'three';

// Called after static batching: these small meshes belong to the garden kit for disposal.
export function createKoi(k,pond){
 const {group,orb,mesh,ring}=k,fish=[];
 for(let i=0;i<3;i++){
  const model=group('Tea garden koi '+(i+1),pond);
  orb(model,.18,[0,0,0],'coral',[.72,.18,1.4]);orb(model,.11,[.01,.025,-.025],'cream',[.65,.10,1.2]);
  const tail=group('Koi '+(i+1)+' tail',model,[0,0,-.20]);
  const shape=new T.Shape();shape.moveTo(0,0);shape.lineTo(-.15,-.2);shape.quadraticCurveTo(0,-.14,.15,-.2);shape.closePath();
  mesh(tail,new T.ShapeGeometry(shape),'coral').rotation.x=-Math.PI/2;
  for(const dx of[-.045,.045])orb(model,.01,[dx,.025,.17],'ink');
  fish.push({model,tail});
 }
 const effects=group('Koi feeding ripples and crumbs',pond,[2.18,.272,.05]);effects.visible=false;
 const ripple=ring(effects,.24,.008,[0,0,0],'cream');ripple.rotation.x=Math.PI/2;
 for(let i=0;i<4;i++)orb(effects,.022,[(i%2-.5)*.18,0,(Math.floor(i/2)-.5)*.16],'soil');
 let time=0,until=0,blend=0;
 const target=new T.Vector3();
 function pose(dt){
  blend+=Math.max(-dt*.24,Math.min(dt*.24,(time<until?1:0)-blend));
  fish.forEach(({model,tail},i)=>{
   const phase=time*(.23+i*.045)+i*2.15,rx=1.02-i*.12,rz=.61+i*.035;
   target.set(2.18+rx*Math.cos(phase),.211,.75+rz*Math.sin(phase));
   target.lerp(new T.Vector3(2.18+(i-1)*.23,.211,.05+i*.11),blend*.94);
   const dx=target.x-model.position.x,dz=target.z-model.position.z;
   if(Math.hypot(dx,dz)>.000001)model.rotation.y=Math.atan2(dx,dz);
   model.position.copy(target);tail.rotation.y=.35*Math.sin(time*(5+i*.6)+i*2);
  });
  effects.visible=time<until;const r=1+(time%1.8)*.65;ripple.scale.setScalar(r);
 }
 pose(0);
 return {fish,feed(){until=time+8;},update(dt,reduced=false){if(reduced){effects.visible=false;return;}dt=Math.min(dt,.1);time+=dt;pose(dt);}};
}
