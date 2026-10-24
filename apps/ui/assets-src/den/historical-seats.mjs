// The clearance rigs use the retained authoring table at z=3.15, not the live teahouse.
export function historicalSeatSpots(count){
 const layouts=[[],[0],[-90,90],[-90,0,90],[-90,-35,35,90],[-90,-45,0,45,90],[-90,-45,0,45,90,180]];
 return layouts[count].map(angle=>{
  const radians=angle*Math.PI/180,x=3.5*Math.sin(radians),z=2.5*Math.cos(radians);
  return {x,z:z+3.15,yaw:Math.atan2(-x,-z)};
 });
}
