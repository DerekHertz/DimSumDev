import * as T from 'three';

export function createMeetingPresentation(){
 const root=new T.Group(),activePlace=new T.Mesh(new T.TorusGeometry(1.15,.025,4,48),new T.MeshBasicMaterial({color:'#d9ad77',transparent:true,opacity:.65,depthWrite:false}));
 activePlace.rotation.x=-Math.PI/2;activePlace.visible=false;root.add(activePlace);
 const position=new T.Vector3();
 function update(meeting,seats){
  const role=meeting?.live?.role;
  const active=meeting?.state==='running'&&!meeting.retired&&(role==='orchestrator'||meeting.seats?.some(seat=>seat.role===role));
  const model=active?seats.get(role):null;
  activePlace.visible=!!model;
  if(model){model.getWorldPosition(position);position.y=.46;root.worldToLocal(position);activePlace.position.copy(position);}
 }
 return {root,activePlace,update,dispose(){root.removeFromParent();activePlace.geometry.dispose();activePlace.material.dispose();}};
}
