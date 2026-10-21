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
 const spots=den.routineSpots||[],places=transport.places;let time=0,nextDeparture=2,cursor=0,visit=0;
 for(const a of actors.values())a.routine=null;
 const release=a=>{if(a.routine)places.release(a.routine.place.id,a.identity);};
 function cancel(a){release(a);a.routine=null;}
 function returnHome(a){
  release(a);a.routine.stage='return';a.leaving=true;transport.home(a);
 }
 function interrupt(a){if(!a.routine)return;returnHome(a);a.routine=null;}
 function update(dt,reduced,held){
  if(!reduced)time+=dt;
  for(const [key,a]of actors){
   if(reduced){if(a.routine){returnHome(a);a.routine=null;}continue;}
   const r=a.routine;if(!r)continue;
   if(a.live||a.seat){interrupt(a);continue;}
   if(key===held)continue;
   if(r.stage==='outbound'&&a.travel?.status==='unavailable'){
    returnHome(a);a.routineFailures??=new Map();a.routineFailures.set(r.spot.id,{place:r.place.id,revision:r.place.revision,navigation:den.walkWorld.navigation.revision});
    a.routine=null;a.nextRoutine=time+18;continue;
   }
   if(r.stage==='outbound'&&a.travel?.placeId===r.place.id&&a.travel.status==='arrived'){r.stage='visit';r.elapsed=0;if(r.spot.kind==='pond')den.feedKoi?.();}
   if(r.stage==='visit'){
    r.elapsed+=dt;const p=a.panda.model.position;a.panda.model.rotation.y=Math.atan2(r.spot.face.x-p.x,r.spot.face.z-p.z);
    if(r.elapsed>=10+(a.index%3)*2)returnHome(a);
   }else if(r.stage==='return'&&!a.leaving){cancel(a);a.nextRoutine=time+14+a.index%5*3;}
  }
  if(reduced||!spots.length||time<nextDeparture)return;
  nextDeparture=time+4;
  if([...actors.values()].filter(a=>a.routine).length>=3)return;
  const candidates=[...actors.values()].filter(a=>!a.stationary&&!a.visitor&&!a.guest&&a.panda.model.visible&&a.homePlace);
  // At most one route attempt per departure beat, even when a destination is unreachable.
  for(let i=0;i<candidates.length;i++){
   const a=candidates[cursor++%candidates.length];
   if(a.live||a.seat||a.leaving||a.arriving||a.path?.length||a.routine||a.id===held||(a.nextRoutine||0)>time)continue;
   const spot=spots.slice(visit%spots.length).concat(spots.slice(0,visit%spots.length)).find(s=>{
    const failure=a.routineFailures?.get(s.id),unchanged=failure&&places.get(failure.place)?.revision===failure.revision&&den.walkWorld.navigation.revision===failure.navigation;
    return !unchanged&&!places.get('leisure:'+s.id)?.owner&&(!s.available||s.available());
   });
   if(!spot)return;
   visit++;a.nextRoutine=time+18;
   const p=a.panda.model.position;
   if(den.walkWorld.navigation.groundAt(p.x,p.z,p.y,a.envelope.radius,a.envelope.height)===null){a.presentation='Waiting for a safe route';return;}
   const place=transport.destination(a,{id:'leisure:'+spot.id,kind:'leisure',position:spot.position,overflow:false});
   if(place&&transport.go(a,place))a.routine={spot,place,stage:'outbound',elapsed:0};
   return;
  }
 }
 return {update,interrupt,cancel,dispose(){for(const a of actors.values())cancel(a);}};
}
