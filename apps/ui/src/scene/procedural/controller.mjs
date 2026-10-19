import { planPlacements, poseFor } from './bindings.mjs';

// Reconcile by ticket ref, so refreshes do not recreate skeletons or restart a panda's life.
export function createLiveDenController(den,{onCreate=()=>{},onRemove=()=>{},ticketPandas=true}={}) {
  const figures=new Map();
  let elapsed=0;
  const baseObstacles=[...den.obstacles];
  function sync(placements,frontier=[],rods=[]) {
    // ticketPandas:false leaves live agents to the role pandas (den-layout/03): no panda per held ticket.
    const planned=ticketPandas?planPlacements(placements):[],wanted=new Map(planned.map(c=>[c.ref,c]));
    for(const [ref,f] of figures){
      if(!wanted.has(ref)||wanted.get(ref).role!==f.placement.role){
        onRemove(ref);den.removeTicketPanda(f.panda);figures.delete(ref);
      }
    }
    for(const placement of planned){
      let f=figures.get(placement.ref);
      if(!f){
        const panda=den.createTicketPanda(placement.role,placement.placement);
        panda.model.userData.ticketRef=placement.ref;
        f={panda,placement};figures.set(placement.ref,f);onCreate(panda);
      }
      f.placement=placement;den.placeTicketPanda(f.panda,placement.placement);
    }
    den.obstacles.splice(0,den.obstacles.length,...baseObstacles,...planned.filter(c=>c.placement.parent==='world').map(c=>({
      type:'circle',x:c.placement.position[0],z:c.placement.position[2],radius:0.32,
    })));
    den.setFrontier(frontier);den.setTally(rods);
  }
  function update(delta,{reducedMotion=false,selected=null}={}) {
    if(!reducedMotion)elapsed+=delta;
    for(const f of figures.values()){
      f.panda.bones.Head.rotation.x-=f.headOffset||0;
      for(const side of ['L','R']){const lid=f.panda.model.getObjectByName('Lid_'+side);if(lid?.morphTargetInfluences&&f.baseLids)lid.morphTargetInfluences[0]=f.baseLids[side];}
      for(const name of ['Root','Shoulder_L','Shoulder_R','Elbow_L','Elbow_R','Wrist_L','Wrist_R'])f.panda.bones[name]?.rotation.set(0,0,0);
    }
    den.update(reducedMotion?0:delta,elapsed);
    for(const [ref,f] of figures){
      const {panda,placement}=f;
      const p=poseFor(placement.pose,elapsed,reducedMotion),b=panda.bones;
      b.Root.rotation.x=p.root;
      // Head's breathing is supplied by the mixer's base clip each frame.
      b.Head.rotation.x+=p.head;f.headOffset=p.head;
      f.baseLids={};
      if(placement.pose==='waiting_on_user'){
        b.Shoulder_L.rotation.z=p.arm;b.Elbow_L.rotation.z=p.elbow;b.Wrist_L.rotation.z=p.wrist;
      }else if(placement.pose==='blocked'){
        b.Shoulder_L.rotation.x=0.14;b.Shoulder_R.rotation.x=0.14;
        b.Shoulder_L.rotation.z=-p.arm;b.Shoulder_R.rotation.z=p.arm;
        b.Elbow_L.rotation.z=-p.elbow;b.Elbow_R.rotation.z=p.elbow;
      }else{
        b.Shoulder_L.rotation.x=p.arm;b.Shoulder_R.rotation.x=p.arm;
        b.Elbow_L.rotation.z=p.elbow;b.Elbow_R.rotation.z=-p.elbow;b.Wrist_L.rotation.y=p.wrist;
      }
      for(const side of ['L','R']){
        const lid=panda.model.getObjectByName('Lid_'+side);
        if(lid?.morphTargetInfluences){f.baseLids[side]=lid.morphTargetInfluences[0];lid.morphTargetInfluences[0]=Math.max(lid.morphTargetInfluences[0],p.sleepiness);}
      }
      panda.materials.cream.emissive?.set(ref===selected?'#08676b':'#000000');
      panda.materials.cream.emissiveIntensity=ref===selected?0.12:0;
    }
  }
  function dispose(){for(const [ref,f] of figures){onRemove(ref);den.removeTicketPanda(f.panda);}figures.clear();den.obstacles.splice(0,den.obstacles.length,...baseObstacles);}
  return {figures,sync,update,dispose};
}
