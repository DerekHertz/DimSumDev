// Landscape infill for the approved layout. Buildings and existing walks stay put.
import * as T from 'three';
import { gardenKit } from './garden-kit.mjs';
import { bounds } from './plan.mjs';

export function createGardenInfill({places,walks,connectors,extraWalks,ground}){
 const k=gardenKit('Planned garden beds, paved courts, and little places to grow'),{root,group,mesh,box,cyl,beam,tube,sign,bao}=k;
 k.materials.jadeLight.color.set('#98b77e');k.materials.grass.color.set('#b2c78f');k.materials.soil.color.set('#9b8764');
 const beds=group('Planted crescents and flowering meadow islands'),paving=group('Stone forecourts and a welcoming arrival square'),plots=group('Three garden plots reserved for little future additions'),edges=group('Setts along the main garden walks');
 const reserved=[],features=[],skipped=[];
 const plotSpecs=[{x:-8,z:-28.8,w:6.0,d:4.6},{x:0,z:-28.8,w:6.0,d:4.6},{x:8,z:-28.8,w:6.0,d:4.6}];
 const futureLane=[{x:-7.8,z:-9.8},{x:-9.8,z:-12.5},{x:-9.8,z:-23.8},{x:0,z:-24.0},{x:10.5,z:-24.0},{x:10.5,z:-21.3}];
 const pathSets=[...walks,...connectors.filter(c=>c.points).map(c=>c.points),...extraWalks,futureLane];
 const protectedBoxes=places.map(p=>bounds(p,.65));
 const distance=(p,a,b)=>{const dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz||1)));return Math.hypot(p.x-a.x-t*dx,p.z-a.z-t*dz);};
 function clear(x,z,margin=.35){
  if(protectedBoxes.some(b=>x>b.x0-margin&&x<b.x1+margin&&z>b.z0-margin&&z<b.z1+margin))return false;
  if(pathSets.some(path=>path.some((p,i)=>i&&distance({x,z},path[i-1],p)<1.0+margin)))return false;
  return (Math.abs(x)/46.5)**(2/.58)+(Math.abs(z+4)/41.5)**(2/.58)<.98;
 }
 const sphere=new T.SphereGeometry(1,8,6);
 function soft(parent,r,at,color,scale=[1,1,1]){const m=mesh(parent,sphere,color,at);m.scale.set(r*scale[0],r*scale[1],r*scale[2]);return m;}
 function shape(points){const s=new T.Shape();points.forEach(([x,z],i)=>i?s.lineTo(x,-z):s.moveTo(x,-z));s.closePath();return s;}
 function layer(parent,points,base,top,color,bevel=.05){const b=Math.min(bevel,(top-base)*.4),g=new T.ExtrudeGeometry(shape(points),{depth:top-base-2*b,bevelEnabled:true,bevelThickness:b,bevelSize:b,bevelSegments:2,curveSegments:3});g.rotateX(-Math.PI/2);return mesh(parent,g,color,[0,base+b,0]);}
 function polygonBounds(points,padding=.25){return{x0:Math.min(...points.map(p=>p[0]))-padding,x1:Math.max(...points.map(p=>p[0]))+padding,z0:Math.min(...points.map(p=>p[1]))-padding,z1:Math.max(...points.map(p=>p[1]))+padding};}
 function bloom(parent,x,y,z,color,seed){
  const h=.25+.14*(.5+.5*Math.sin(seed*2.7));beam(parent,[x,y,z],[x,y+h,z],.015,'jadeDeep');
  for(let j=0;j<5;j++){const a=j/5*Math.PI*2;soft(parent,.066,[x+Math.cos(a)*.068,y+h+Math.sin(a)*.06,z],color,[1,1,.54]);}soft(parent,.033,[x,y+h,z+.025],'gold');
  for(const side of[-1,1]){const leaf=soft(parent,.11,[x+side*.08,y+h*.43,z],'jade',[.35,.15,1.1]);leaf.rotation.y=side*.8;}
 }
 function plants(parent,points,seed,palette){
  let i=0;for(const[x,z]of points){const r=.25+.10*(.5+.5*Math.sin(i*2.3+seed));soft(parent,r,[x,ground+.27,z],i%3?'jadeLight':'jade',[1.3,.62,1]);if(i%2===0)bloom(parent,x,ground+.32,z,palette[i%palette.length],i+seed);i++;}
 }
 // Four low crescent beds furnish the lawns between Bao's circle and the outer loop.
 for(let quadrant=0;quadrant<4;quadrant++){
  const a0=[20,126,200,306][quadrant]*Math.PI/180,a1=a0+34*Math.PI/180,points=[];
  for(let i=0;i<=24;i++){const a=a0+(a1-a0)*i/24;points.push([Math.cos(a)*10.45,Math.sin(a)*10.45]);}
  for(let i=24;i>=0;i--){const a=a0+(a1-a0)*i/24;points.push([Math.cos(a)*8.8,Math.sin(a)*8.8]);}
  if(!points.every(([x,z])=>clear(x,z,.25))){skipped.push('crescent-'+quadrant);continue;}
  const bed=group('Planted crescent '+(quadrant+1),beds);layer(bed,points,ground+.015,ground+.19,'stone');
  const inner=[];for(let i=0;i<=24;i++){const a=a0+.035+(a1-a0-.07)*i/24;inner.push([Math.cos(a)*10.25,Math.sin(a)*10.25]);}for(let i=24;i>=0;i--){const a=a0+.035+(a1-a0-.07)*i/24;inner.push([Math.cos(a)*9.0,Math.sin(a)*9.0]);}layer(bed,inner,ground+.16,ground+.205,'soil',.025);
  const planting=[];for(let i=0;i<15;i++){const a=a0+.07+(a1-a0-.14)*i/14,r=9.2+(i%2)*.75;planting.push([Math.cos(a)*r,Math.sin(a)*r]);}plants(bed,planting,quadrant,['pink','lilac','cream']);reserved.push(polygonBounds(points));features.push({kind:'crescent',name:bed.name});
 }
 const meadowSpecs=[[-36,-14,4.3,6.0],[-32,4,3.4,5.2],[38,-4,3.8,6.2],[38,23,2.8,3.8],[-29,30,5.3,2.5],[-7,32,5.3,2.5],[11,32,5.2,2.5],[23,30,5.2,3.1]];
 for(const[seed,spec]of meadowSpecs.entries()){
  const[x,z,rx,rz]=spec,points=Array.from({length:64},(_,i)=>{const a=i/64*Math.PI*2,r=1+.045*Math.sin(a*5+seed);return[x+Math.cos(a)*rx*r,z+Math.sin(a)*rz*r];});
  if(!points.every(([x,z])=>clear(x,z,.28))){skipped.push('meadow-'+seed);continue;}
  const bed=group('Flowering meadow island '+(seed+1),beds);layer(bed,points,ground+.012,ground+.15,'stone',.055);layer(bed,points.map(([px,pz])=>[x+(px-x)*.94,z+(pz-z)*.91]),ground+.13,ground+.22,'jadeLight',.035);
  const pointsToPlant=[];for(let i=0;i<39;i++){const a=i*2.39996,r=Math.sqrt((i+.5)/39)*.84;pointsToPlant.push([x+Math.cos(a)*rx*r,z+Math.sin(a)*rz*r]);}plants(bed,pointsToPlant,seed*4,['pink','cream','lilac','gold']);
  for(let i=0;i<4;i++){const a=i*2.4+seed;soft(bed,.48,[x+Math.cos(a)*rx*.66,ground+.32,z+Math.sin(a)*rz*.66],'jade',[1.7,.65,1.1]);}
  reserved.push(polygonBounds(points));features.push({kind:'meadow',name:bed.name});
 }
 function plaza(name,x,z,w,d){
  const p=group(name,paving,[x,ground, z]);box(p,[w,.055,d],[0,.0275,0],'honey',.16);
  const nx=Math.floor((w-.24)/.72),nz=Math.floor((d-.24)/.72),sx=(w-.26)/nx,sz=(d-.26)/nz;
  for(let i=0;i<nx;i++)for(let j=0;j<nz;j++)box(p,[sx-.028,.035,sz-.028],[(i-(nx-1)/2)*sx,.069,(j-(nz-1)/2)*sz],(i+j)%7===0?'paleWood':'stone',.045);
  features.push({kind:'plaza',name});return p;
 }
 const arrival=plaza('Arrival square · warm stone pavers',0,29.0,6.8,5.0);
 const medallion=cyl(arrival,.71,.016,[0,.095,0],'jadeLight');
 for(let i=0;i<5;i++){const a=i/5*Math.PI*2,leaf=soft(arrival,.24,[Math.cos(a)*.26,.11,Math.sin(a)*.26],'jade',[.35,.07,1.25]);leaf.rotation.y=Math.PI/2-a;}cyl(arrival,.08,.018,[0,.114,0],'gold');
 // Seats stay on the flanks, leaving the arrival walk open through the middle.
 for(const x of[-2.65,2.65]){box(arrival,[.67,.12,1.45],[x,.64,-.13],'paleWood',.07);for(const z of[-.61,.37])beam(arrival,[x,.08,z],[x,.58,z],.06,'timber');}
 plaza('A paved gathering apron before the festival',-27,13.0,7.6,2.6);
 plaza('The library threshold court',-14.3,6.0,2.3,3.2);
 plaza('Front of House threshold court',14.2,5.0,2.3,3.2);
 // Tiny paved edging gives the large loop a deliberate, garden-like finish.
 for(const[rx,rz,count]of[[15.8,11.2,112],[6.5,6.5,56]])for(let i=0;i<count;i++){
  const a=i/count*Math.PI*2,x=rx*Math.cos(a),z=rz*Math.sin(a),tx=-rx*Math.sin(a),tz=rz*Math.cos(a),len=Math.hypot(tx,tz),nx=tz/len,nz=-tx/len;
  if(Math.abs(x)<1.6||Math.abs(z)<1.6)continue;
  if(connectors.some(({points})=>points?.some(p=>Math.hypot(p.x-x,p.z-z)<1.9)))continue;
  for(const side of[-1,1]){const stone=box(edges,[.19,.065,.44],[x+nx*1.04*side,ground+.035,z+nz*1.04*side],i%5?'stone':'paleWood',.025);stone.rotation.y=Math.atan2(tx,tz);}
 }
 // Future plots are finished garden clearings, with room for later small additions.
 for(const[index,s]of plotSpecs.entries()){
  const p=group('Room to grow · garden plot '+(index+1),plots,[s.x,ground,s.z]);
  box(p,[s.w,.10,s.d],[0,.05,0],'paleWood',.14);box(p,[s.w-.28,.035,s.d-.28],[0,.115,0],'cream',.09);box(p,[s.w-.78,.025,s.d-.78],[0,.145,0],'grass',.08);
  for(const x of[-s.w/2+.16,s.w/2-.16])for(const z of[-s.d/2+.16,s.d/2-.16]){cyl(p,.075,.29,[x,.18,z],'honey');soft(p,.083,[x,.34,z],'jade');}
  for(let i=0;i<3;i++){const leaf=soft(p,.23,[(i-1)*.25,.22,-.17+Math.abs(i-1)*.14],'jade',[.4,.14,1.2]);leaf.rotation.y=(i-1)*.7;}
  if(index===1){beam(p,[0,.14,1.71],[0,.88,1.71],.035,'timber');sign(p,'ROOM TO GROW',[0,.85,1.75],2.0);}
  reserved.push({x0:s.x-s.w/2-.35,x1:s.x+s.w/2+.35,z0:s.z-s.d/2-.35,z1:s.z+s.d/2+.35});features.push({kind:'plot',name:p.name});
 }
 // Recessed stepping stones join the reserved clearings to the rear garden lane.
 function stoneWalk(points){for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],n=Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.77);for(let j=0;j<n;j++){const t=j/n,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t;const m=box(edges,[.64,.045,.56],[x,ground+.034,z],'stone',.07);m.rotation.y=Math.atan2(b.x-a.x,b.z-a.z);}}}
 stoneWalk(futureLane);for(const s of plotSpecs)stoneWalk([{x:s.x,z:-24},{x:s.x,z:s.z+s.d/2}]);
 bao(arrival,[2.67,.78,.24],.7);
 k.finish();
 return{root,beds,paving,plots,edges,reserved,futureLane,features,skipped,dispose:k.dispose};
}
