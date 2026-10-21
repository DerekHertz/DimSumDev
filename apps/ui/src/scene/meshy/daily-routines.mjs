export function gardenRoutineSpots(garden){
 const tea=garden.assets.tea,point=p=>garden.worldPoint('tea',p);
 return [
  {id:'tea',kind:'tea',position:point([-1.7,.43,1.0]),face:point([-1.7,.43,.02])},
  {id:'pond',kind:'pond',position:point([2.18,0,-1.35]),face:point([2.18,0,.05])},
  {id:'greeting',kind:'greeting',position:point([-.10,.43,-1.6]),face:point(tea.residents[0].position)},
 ];
}

// One scene clock and departure cursor. Paths are searched only at departures or interruptions.
export function createDailyRoutines(den,actors,transport){
 const spots=den.routineSpots||[],places=transport.places,pendingOutings=new Map();let time=0,nextDeparture=2,cursor=0,visit=0;
 for(const a of actors.values())a.routine=null;
 const release=a=>{if(a.routine?.place)places.release(a.routine.place.id,a.identity);};
 function cancelPending(a){if(pendingOutings.delete(a)){a.leaving=true;transport.home(a);}}
 function cancel(a){cancelPending(a);release(a);a.routine=null;}
 function returnHome(a){
  release(a);a.routine.stage='return';a.leaving=true;transport.home(a);
 }
 function interrupt(a){cancelPending(a);if(!a.routine)return;returnHome(a);a.routine=null;}
 function failed(a,r){
  const place=r.place??places.get('leisure:'+r.spot.id);
  a.routineFailures??=new Map();a.routineFailures.set(r.spot.id,{place:place?.id??'leisure:'+r.spot.id,revision:place?.revision,navigation:den.walkWorld.navigation.revision,groundAt:den.walkWorld.navigation.groundAt});
  a.nextRoutine=time+18;
 }
 function update(dt,reduced,held){
  if(!reduced)time+=dt;
  for(const [key,a]of actors){
   if(reduced){cancelPending(a);if(a.routine){returnHome(a);a.routine=null;}continue;}
   const waiting=pendingOutings.get(a);
   if(waiting){
    if(a.live||a.seat)cancelPending(a);
    else if(key===held)continue;
    else{
     const place=places.get('leisure:'+waiting.spot.id),trip=a.travel;
     // An intended outing becomes a routine only after the common transport
     // admits owned travel. Rejection is never an outbound activity or visit.
     if(place?.owner===a.identity&&trip?.placeId===place.id&&['moving','yielding','arrived'].includes(trip.status)){
      pendingOutings.delete(a);a.routine={...waiting,place,stage:'outbound',elapsed:0};
     }else if(a.routeTries>=3){cancelPending(a);failed(a,waiting);}
    }
   }
   const r=a.routine;if(!r)continue;
   if(a.live||a.seat){interrupt(a);continue;}
   if(key===held)continue;
   if(r.stage==='outbound'&&a.travel?.status==='unavailable'){
    returnHome(a);failed(a,r);a.routine=null;continue;
   }
   if(r.stage==='outbound'&&a.travel?.placeId===r.place.id&&a.travel.status==='arrived'){r.stage='visit';r.elapsed=0;if(r.spot.kind==='pond')den.feedKoi?.();}
   if(r.stage==='visit'){
    r.elapsed+=dt;const p=a.panda.model.position;a.panda.model.rotation.y=Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z);
    if(r.elapsed>=10+(a.index%3)*2)returnHome(a);
   }else if(r.stage==='return'&&!a.leaving){cancel(a);a.nextRoutine=time+14+a.index%5*3;}
  }
  if(reduced||!spots.length||time<nextDeparture)return;
  nextDeparture=time+4;
  if([...actors.values()].filter(a=>a.routine).length+pendingOutings.size>=3)return;
  const candidates=[...actors.values()].filter(a=>!a.stationary&&!a.visitor&&!a.guest&&a.panda.model.visible&&a.homePlace);
  // At most one route attempt per departure beat, even when a destination is unreachable.
  for(let i=0;i<candidates.length;i++){
   const a=candidates[cursor++%candidates.length];
   if(a.live||a.seat||a.leaving||a.arriving||a.path?.length||a.routine||pendingOutings.has(a)||a.id===held||(a.nextRoutine||0)>time)continue;
   const spot=spots.slice(visit%spots.length).concat(spots.slice(0,visit%spots.length)).find(s=>{
    const failure=a.routineFailures?.get(s.id),unchanged=failure&&places.get(failure.place)?.revision===failure.revision&&den.walkWorld.navigation.revision===failure.navigation&&den.walkWorld.navigation.groundAt===failure.groundAt;
    return !unchanged&&!places.get('leisure:'+s.id)?.owner&&(!s.available||s.available());
   });
   if(!spot)return;
   visit++;a.nextRoutine=time+18;
   const p=a.panda.model.position;
   if(den.walkWorld.navigation.groundAt(p.x,p.z,p.y,a.envelope.radius,a.envelope.height)===null){a.presentation='Waiting for a safe route';return;}
   const place=transport.destination(a,{id:'leisure:'+spot.id,kind:'leisure',position:spot.position,overflow:false});
   if(transport.go(a,place))a.routine={spot,place,stage:'outbound',elapsed:0};else pendingOutings.set(a,{spot,place});
   return;
  }
 }
 return {update,interrupt,cancel,dispose(){for(const a of actors.values())cancel(a);}};
}
