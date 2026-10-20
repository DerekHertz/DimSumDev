// Standalone visual studies: approved leisure-garden style, three working pairs.
import * as T from 'three';
import { gardenKit, COLORS } from './garden-kit.mjs';

export const PAIRS={
 pass:{name:'The idea garden',team:'PASS',roles:['Product','Architect'],colors:['coral','blue'],vests:['#c58e86','#7b95b0'],hats:[null,'architect'],tag:'Small ideas. Room to grow.',features:[['Product’s little planning corner','A story board, paper idea cards, a journal, and a tiny wish jar.'],['Architect’s model-making desk','A paper blueprint, rolled drawings, and a miniature timber pavilion.'],['A place to think together','Two personal bays, a shared tea shelf, and a tiny bridge between ideas.']]},
 pantry:{name:'A little peace of mind',team:'TEA & PANTRY',roles:['QA','Security'],colors:['jade','lilac'],vests:['#7b9c88','#9b8aaa'],hats:[null,null],tag:'Care in the small things.',features:[['QA’s playful test bench','A marble run, sample drawers, a magnifying lens, and a well-used check sheet.'],['Security’s quiet watch','A rounded bamboo lockbox, a brass key tray, and an inspection desk.'],['Comfort while taking care','Soft cushions, a biscuit tin, and a little guardian asleep beside the safe.']]},
 front:{name:'Good things, beautifully told',team:'FRONT OF HOUSE',roles:['Designer','Herald'],colors:['pink','gold'],vests:['#c595a0','#bd9c66'],hats:['designer',null],tag:'Make something. Tell its story.',features:[['Designer’s colorful studio','A garden easel, paint cups, fabric swatches, and a clay mascot in progress.'],['Herald’s writing corner','A chunky typewriter, drying story pages, envelopes, and a tiny announcement bell.'],['A shared wall of good things','Personal keepsakes, a paper garland, and room to sit and share a cup.']]},
};

export function createWorkPavilion(id){
 const spec=PAIRS[id],k=gardenKit(spec.name),{root,group,mesh,box,cyl,orb,ring,beam,tube,panel,sign,lantern,bamboo,flowers,teaSet,bao}=k;
 root.userData={reviewOnly:false,assetId:`${id}-pavilion-study`,entrance:'+Z',styleReference:'Approved mahjong, tea garden, and sleepy nook'};
 const deck=group('Rounded timber terrace, stitched rugs, and front steps');
 box(deck,[12.0,.30,8.0],[0,.08,0],'timber',.14);
 for(let i=0;i<32;i++)box(deck,[.36,.075,7.84],[-5.76+i*.372,.267,0],i%5?'honey':'paleWood',.012);
 for(const[z,y,w]of[[4.12,.13,4.4],[4.52,.01,3.8]])box(deck,[w,.16,.62],[0,y,z],'paleWood',.07);
 const frame=group('Bamboo pillars with rounded timber joints');
 for(const x of[-5.4,5.4])for(const z of[-3.25,3.10]){
  cyl(frame,.14,4.0,[x,2.31,z],'timber');cyl(frame,.22,.15,[x,.4,z],'paleWood');
  for(const y of[1.0,1.65,2.3,2.95,3.6])cyl(frame,.155,.055,[x,y,z],'honey');
  for(const dx of[-.53,.53])beam(frame,[x,3.55,z],[x+dx,4.21,z],.065,'honey');
 }
 for(const z of[-3.25,3.10])beam(frame,[-5.6,4.28,z],[5.6,4.28,z],.105,'timber');
 for(const x of[-5.4,5.4]){beam(frame,[x,4.28,-3.4],[x,4.28,3.25],.10,'timber');
  for(const z of[-2.7,-1.9,-1.1,-.3])beam(frame,[x,.42,z],[x,1.04,z],.045,'honey');beam(frame,[x,1.08,-2.95],[x,1.08,-.05],.06,'paleWood');}
 const shade=group('Overlapping giant leaf roof with bamboo ribs');
 const leafMaterial=k.materials.jade.clone();leafMaterial.side=T.DoubleSide;
 function leaf(cx,cz,rx,rz,height,tilt,color){
  const radial=14,angular=72,vertices=[],indices=[];
  const point=(a,t)=>[cx+Math.cos(a)*rx*t,height-.40*t**1.4+tilt*Math.cos(a)*t+.035*Math.sin(a*8)*t,cz+Math.sin(a)*rz*t*(1+.035*Math.sin(a*8))];
  for(let i=0;i<=radial;i++)for(let j=0;j<=angular;j++){vertices.push(...point(j/angular*Math.PI*2,i/radial));if(i<radial&&j<angular){const v=i*(angular+1)+j;indices.push(v,v+angular+1,v+1,v+1,v+angular+1,v+angular+2);}}
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();const mat=leafMaterial.clone();mat.color.copy(k.materials[color].color);mesh(shade,g,mat);
  for(let i=0;i<14;i++)tube(shade,Array.from({length:17},(_,j)=>{const p=point(i/14*Math.PI*2,.025+j/16*.975);p[1]+=.018;return p;}),i%2?.015:.023,'jadeLight',20);
  tube(shade,Array.from({length:73},(_,j)=>point(j/72*Math.PI*2,1)),.028,'jadeDeep',72);
  orb(shade,.17,[cx,height+.05,cz],'jadeLight',[1,.4,1]);
 }
 leaf(-2.80,-.12,3.65,4.25,4.91,-.03,'jade');leaf(2.80,.12,3.65,4.25,5.12,.04,'jade');leaf(0,-1.45,2.2,2.8,5.20,0,'jadeLight');leafMaterial.dispose();
 for(const x of[-5.4,5.4])tube(shade,[[x,4.28,-3.25],[x*.75,4.52,-2.0],[x*.52,4.9,0]],.075,'jadeDeep');
 for(const x of[-4.85,0,4.85])lantern(shade,[x,4.24,2.85],.72,x===0?'cream':spec.colors[x<0?0:1]);
 // Signs and lanterns belong to the removable roof so interior views stay open.
 sign(shade,spec.team,[0,4.12,3.22],3.1);
 const bays=spec.roles.map((role,index)=>{
  const accent=spec.colors[index],bay=group(`${role} · personal workstation`,root,[index?3.05:-3.05,.315,0]);
  box(bay,[4.55,.025,5.6],[0,.01,-.05],accent,.025);
  for(const x of[-2.10,2.10])box(bay,[.025,.01,5.26],[x,.03,-.05],'cream',.002);
  for(let i=0;i<17;i++)for(const z of[-2.88,2.78])beam(bay,[-1.95+i*.24,.03,z],[-1.95+i*.24,.03,z+.10],.008,'cream');
  box(bay,[3.48,.18,1.40],[0,1.14,-.64],'paleWood',.08);
  for(const x of[-1.4,1.4])for(const z of[-1.13,-.17])cyl(bay,.065,1.04,[x,.57,z],'timber');
  box(bay,[.78,.73,1.0],[1.13,.66,-.64],accent,.07);
  for(const y of[.43,.68,.93]){box(bay,[.67,.18,.035],[1.13,y,-.115],'cream',.012);orb(bay,.035,[1.13,y,-.08],'gold');}
  const stool=group('Padded personal stool',bay,[.6,0,1.64]);cyl(stool,.42,.18,[0,.22,0],'timber');box(stool,[.80,.17,.75],[0,.39,0],accent,.09);const seam=ring(stool,.28,.008,[0,.479,0],'cream');seam.rotation.x=Math.PI/2;
  for(const x of[-1.56,1.56])beam(bay,[x,.10,-2.72],[x,3.02,-2.72],.045,'timber');
  beam(bay,[-1.61,3.02,-2.72],[1.61,3.02,-2.72],.045,'honey');
  sign(bay,role.toUpperCase(),[0,2.96,-2.65],1.95,index?'blueDeep':'jadeDeep');
  return bay;
 });
 function paper(p,at,draw,w=1.4,h=.85){const m=panel(p,[w,h],at,draw);m.rotation.x=-Math.PI/2;return m;}
 function page(c,w,h,heading){c.fillStyle=COLORS.cream;c.fillRect(0,0,w,h);c.fillStyle=COLORS.ink;c.font=`600 ${h*.11}px sans-serif`;c.fillText(heading,30,h*.18);c.strokeStyle=COLORS.jade;c.lineWidth=3;for(let i=0;i<5;i++){c.beginPath();c.moveTo(35,h*(.33+i*.12));c.lineTo(w*(i%2?.74:.90),h*(.33+i*.12));c.stroke();}}
 function board(p,name,draw){box(p,[3.32,1.64,.14],[0,2.03,-2.65],'honey',.07);panel(p,[3.10,1.42],[0,2.03,-2.57],draw);}
 function book(p,x,y,z,color,h=.42){box(p,[.18,h,.4],[x,y+h/2,z],color,.015);box(p,[.11,.045,.01],[x,y+h*.72,z+.208],'cream',.003);}
 function shelf(p){for(const x of[-1.58,1.58])box(p,[.09,1.58,.48],[x,.84,-2.64],'timber');for(const y of[.15,1.1])box(p,[3.3,.10,.64],[0,y,-2.61],'paleWood');}
 function cup(p,at,color){cyl(p,.10,.18,[at[0],at[1]+.09,at[2]],color,.12);cyl(p,.099,.01,[at[0],at[1]+.184,at[2]],'soil');ring(p,.072,.018,[at[0]+.13,at[1]+.09,at[2]],color);}
 if(id==='pass'){
  const[p,a]=bays;
  board(p,'Story cards',(c,w,h)=>{c.fillStyle='#efe1b9';c.fillRect(0,0,w,h);for(let col=0;col<3;col++){c.fillStyle=COLORS.ink;c.font='bold 24px sans-serif';c.fillText(['WISH','TRY','GROW'][col],25+col*w/3,35);for(let row=0;row<2;row++){c.fillStyle=[COLORS.pink,COLORS.jadeLight,COLORS.cream][col];c.fillRect(24+col*w/3,60+row*h*.40,w*.26,h*.31);c.fillStyle=COLORS.ink;for(let i=0;i<3;i++)c.fillRect(42+col*w/3,90+row*h*.40+i*17,w*(.14-i*.025),3);}}});
  paper(p,[-.54,1.24,-.54],(c,w,h)=>page(c,w,h,'one little idea'));book(p,.55,1.24,-.93,'coral',.26);cup(p,[-1.32,1.24,-.58],'coral');
  const jar=group('Tiny wish jar',p,[1.25,1.30,-.85]);cyl(jar,.15,.28,[0,.14,0],'blue');cyl(jar,.17,.045,[0,.30,0],'gold');for(let i=0;i<3;i++)box(jar,[.12,.17,.014],[(i-1)*.07,.34,.01],i%2?'cream':'pink',.005);
  shelf(a);for(let i=0;i<6;i++)book(a,-1.18+i*.23,.2,-2.58,['blue','cream','jade'][i%3],.48+i%2*.15);
  paper(a,[-.55,1.24,-.47],(c,w,h)=>{c.fillStyle=COLORS.blueDeep;c.fillRect(0,0,w,h);c.strokeStyle='#b9d7df';c.lineWidth=1;for(let x=0;x<w;x+=35){c.beginPath();c.moveTo(x,0);c.lineTo(x,h);c.stroke();}for(let y=0;y<h;y+=35){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}c.strokeStyle=COLORS.cream;c.lineWidth=5;c.strokeRect(w*.19,h*.18,w*.60,h*.64);c.strokeRect(w*.28,h*.28,w*.42,h*.44);c.fillStyle=COLORS.cream;c.font='25px sans-serif';c.fillText('a place for good work',25,h-20);});
  const mini=group('Architect’s miniature pavilion',a,[.68,1.24,-.75]);box(mini,[.85,.08,.72],[0,.04,0],'honey');for(const x of[-.31,.31])for(const z of[-.24,.24])cyl(mini,.025,.44,[x,.29,z],'timber');const roof=orb(mini,.5,[0,.57,0],'jade',[1,.18,.85]);beam(mini,[-.48,.57,0],[.48,.57,0],.02,'jadeDeep');
  for(const x of[-.6,-.25,.1]){const roll=cyl(a,.075,.76,[x,1.3,-2.6],'cream');roll.rotation.z=Math.PI/2;ring(a,.076,.008,[x,1.3,-2.6],'gold').rotation.y=Math.PI/2;}
  cup(a,[-1.35,1.24,-1],'blue');
 }else if(id==='pantry'){
  const[q,s]=bays;shelf(q);for(let i=0;i<4;i++){box(q,[.67,.39,.45],[-1.15+i*.77,.40,-2.60],i%2?'jadeLight':'cream');box(q,[.27,.12,.012],[-1.15+i*.77,.42,-2.365],'jade',.01);}
  const run=group('QA’s tabletop marble-run experiment',q,[-.28,1.24,-.79]);
  for(const[x,h]of[[-.90,.65],[.70,.30]])cyl(run,.035,h,[x,h/2,0],'timber');
  const path=[[-.96,.68,-.18],[-.38,.54,-.05],[.35,.41,.1],[.76,.32,-.12]];
  for(const dz of[-.09,.09])tube(run,path.map(([x,y,z])=>[x,y,z+dz]),.025,'honey');
  for(let i=0;i<3;i++){orb(run,.065,[-.82+i*.52,.66-i*.13,-.16+i*.09],['coral','gold','blue'][i]);}
  cyl(run,.20,.09,[.78,.045,-.11],'jade');orb(run,.065,[.78,.12,-.11],'lilac');
  paper(q,[-.49,1.24,-.08],(c,w,h)=>{page(c,w,h,'try, learn, repeat');for(let i=0;i<4;i++){c.strokeStyle=COLORS.jadeDeep;c.lineWidth=5;c.strokeRect(40,h*(.3+i*.14),20,20);c.beginPath();c.moveTo(42,h*(.3+i*.14)+9);c.lineTo(49,h*(.3+i*.14)+15);c.lineTo(65,h*(.3+i*.14)-3);c.stroke();}},1.25,.45);
  const lens=ring(q,.17,.035,[1.22,1.65,-.85],'gold');lens.rotation.y=-.2;beam(q,[1.22,1.50,-.85],[1.44,1.25,-.85],.04,'timber');
  sign(q,'TRY AGAIN. HAVE A BISCUIT.',[0,2.1,-2.57],2.65);cup(q,[-1.43,1.24,-.61],'jade');
  const vault=group('Rounded bamboo lockbox',s,[.10,0,-2.43]);box(vault,[2.65,2.10,.95],[0,1.1,0],'lilac',.16);box(vault,[2.29,1.77,.12],[0,1.1,.52],'cream',.10);box(vault,[2.09,1.57,.04],[0,1.1,.60],'jade',.08);
  ring(vault,.24,.035,[.42,1.15,.64],'gold');for(const a of[0,Math.PI*.5,Math.PI,Math.PI*1.5])beam(vault,[.42,1.15,.65],[.42+Math.cos(a)*.22,1.15+Math.sin(a)*.22,.65],.022,'gold');orb(vault,.055,[.42,1.15,.66],'honey');
  for(const y of[.57,1.63])box(vault,[.14,.25,.12],[-.93,y,.64],'gold',.025);sign(vault,'PRECIOUS LITTLE THINGS',[0,2.32,.28],2.68);
  paper(s,[-.6,1.24,-.40],(c,w,h)=>page(c,w,h,'look after the garden'));cup(s,[-1.4,1.24,-.9],'lilac');
  const key=group('Brass key on the inspection tray',s,[.85,1.26,-.47]);box(key,[.8,.04,.47],[0,0,0],'honey');ring(key,.09,.022,[-.13,.04,0],'gold').rotation.x=Math.PI/2;beam(key,[-.05,.04,0],[.25,.04,0],.023,'gold');for(const x of[.16,.24])beam(key,[x,.04,0],[x,.04,.08],.02,'gold');
  const cat=group('Easter egg — tiny sleeping guardian',s,[1.58,.14,2.22]);orb(cat,.22,[0,.11,0],'cream',[1.3,.62,1]);orb(cat,.13,[-.2,.17,.1],'cream');for(const x of[-.26,-.14])orb(cat,.05,[x,.27,.1],'cream',[.6,1,.5]);tube(cat,[[.16,.12,.1],[.33,.14,.03],[.31,.14,-.12],[.17,.14,-.14]],.045,'cream');
  cyl(q,.19,.19,[1.22,1.34,-.19],'coral');cyl(q,.20,.03,[1.22,1.45,-.19],'honey');orb(q,.03,[1.22,1.49,-.19],'gold');
 }else{
  const[d,h]=bays;
  const easel=group('Designer’s garden painting easel',d,[-.25,0,-2.34]);
  for(const x of[-.86,.86])beam(easel,[x,.1,.14],[x*.67,2.52,0],.055,'timber');beam(easel,[0,.1,-.43],[0,2.2,0],.055,'timber');box(easel,[2.1,.09,.28],[0,1.14,.14],'honey');box(easel,[1.84,1.23,.08],[0,1.83,.10],'paleWood');
  panel(easel,[1.65,1.05],[0,1.83,.15],(c,w,h)=>{c.fillStyle='#fff5de';c.fillRect(0,0,w,h);c.fillStyle=COLORS.blue;c.fillRect(0,0,w,h*.57);c.fillStyle=COLORS.jadeLight;c.beginPath();c.ellipse(w*.5,h*.88,w*.65,h*.35,0,0,7);c.fill();c.fillStyle=COLORS.jadeDeep;for(let i=0;i<3;i++){c.fillRect(w*(.16+i*.27),h*.22,w*.022,h*.63);for(let j=0;j<3;j++){c.beginPath();c.ellipse(w*(.16+i*.27)+30,h*(.28+j*.14),45,10,-.5,0,7);c.fill();}}c.fillStyle=COLORS.gold;c.beginPath();c.arc(w*.80,h*.18,35,0,7);c.fill();});
  paper(d,[-.47,1.24,-.42],(c,w,h)=>{c.fillStyle=COLORS.cream;c.fillRect(0,0,w,h);for(let i=0;i<6;i++){c.fillStyle=Object.values(COLORS)[i+2];c.beginPath();c.arc(80+i%3*200,80+Math.floor(i/3)*160,45,0,7);c.fill();}},1.6,.77);
  for(const[x,color]of[[-1.34,'coral'],[1.35,'blue']]){cyl(d,.11,.24,[x,1.37,-.9],color);for(let i=0;i<3;i++){beam(d,[x+(i-1)*.045,1.44,-.9],[x+(i-1)*.1,1.86,-.88],.014,'timber');orb(d,.028,[x+(i-1)*.1,1.86,-.88],['jade','pink','gold'][i],[.5,1,.5]);}}
  const clay=group('Designer’s clay mascot in progress',d,[.65,1.27,-.71]);cyl(clay,.24,.045,[0,0,0],'honey');orb(clay,.18,[0,.17,0],'coral',[1,.9,1]);for(const x of[-.13,.13])orb(clay,.07,[x,.31,0],'coral');for(const x of[-.06,.06])orb(clay,.018,[x,.19,.16],'ink');
  for(let i=0;i<4;i++){const swatch=box(d,[.37,.55,.035],[1.38,2.3-i*.08,-2.41+i*.04],['pink','lilac','jade','gold'][i]);swatch.rotation.z=.12-i*.06;}
  shelf(h);for(let i=0;i<5;i++)book(h,-1.2+i*.25,.2,-2.58,['gold','coral','cream'][i%3],.45+i%2*.09);
  const type=group('Herald’s chunky typewriter',h,[-.35,1.24,-.58]);box(type,[1.62,.19,.92],[0,.10,0],'gold',.08);box(type,[1.52,.34,.32],[0,.32,-.27],'jadeDeep',.06);const roll=cyl(type,.09,1.43,[0,.43,-.28],'ink');roll.rotation.z=Math.PI/2;
  box(type,[.96,.69,.025],[0,.77,-.31],'cream',.008);panel(type,[.88,.59],[0,.77,-.292],(c,w,h)=>page(c,w,h,'from the den'));
  for(let row=0;row<3;row++)for(let col=0;col<10;col++){cyl(type,.035,.035,[-.61+col*.135,.218,.01+row*.12],'cream');}box(type,[.63,.035,.07],[0,.22,.39],'cream',.01);orb(type,.065,[.82,.43,-.28],'gold');
  const rack=group('Pages drying on the story line',h,[0,2.22,-2.5]);tube(rack,[[-1.45,.33,0],[0,.23,.03],[1.45,.33,0]],.014,'timber');
  for(let i=0;i<3;i++){const x=-.95+i*.95;box(rack,[.67,.77,.018],[x,-.1,.03],'cream',.007);box(rack,[.055,.15,.04],[x,.28,.045],'honey',.008);panel(rack,[.58,.63],[x,-.12,.045],(c,w,h)=>page(c,w,h,['a good day','new shoots','little wins'][i]));}
  const bell=group('Tiny announcement bell',h,[1.22,1.24,-.51]);cyl(bell,.19,.045,[0,.025,0],'timber');orb(bell,.16,[0,.10,0],'gold',[1,.7,1]);beam(bell,[0,.16,0],[0,.24,0],.025,'gold');orb(bell,.06,[0,.25,0],'gold');cup(h,[-1.38,1.24,-.93],'coral');
  for(let i=0;i<3;i++){const envelope=group('Folded story envelope',h,[1.14,1.25+i*.018,.02]);envelope.rotation.y=-.12;box(envelope,[.51,.016,.28],[0,0,0],i%2?'pink':'cream',.006);for(const x of[-.24,.24])beam(envelope,[x,.012,-.12],[0,.012,.04],.005,'honey');orb(envelope,.026,[0,.021,.04],'coral',[1,.18,1]);}
 }
 const shared=group('Shared tea shelf and a little friendly clutter');
 box(shared,[1.55,.13,.79],[0,1.24,-2.86],'paleWood');for(const x of[-.57,.57])cyl(shared,.055,.91,[x,.72,-2.86],'timber');teaSet(shared,[0,1.32,-2.86],.92);
 sign(shared,'TEA FOR TWO',[0,2.12,-3.04],1.55);bao(shared,[.30,.64,-2.60],.85);
 const garland=group('Little paper leaf garland',shade,[0,0,0]);tube(garland,[[-2,4.18,2.8],[0,3.84,2.8],[2,4.18,2.8]],.012,'timber');
 for(let i=0;i<7;i++){const x=-1.7+i*.566,y=3.84+.34*(x/2)**2;const leaf=orb(garland,.14,[x,y-.13,2.8],i%2?spec.colors[0]:spec.colors[1],[.55,1.2,.18]);leaf.rotation.z=i%2?.35:-.35;}
 const garden=group('Bamboo pots, blossoms, and lucky small things');
 for(const x of[-5.5,5.5]){bamboo(garden,[x,.315,2.7],.82);box(garden,[1.65,.34,.52],[x*.82,.48,-3.5],'cream',.07);flowers(garden,[x*.82,.66,-3.5],spec.colors[x<0?0:1],1.2);}
 if(id==='pass'){const bridge=group('Easter egg — a bridge between two tiny ideas',shared,[0,.34,1.73]);for(let i=0;i<8;i++)box(bridge,[.16,.04,.45],[-.56+i*.16,.1+.16*Math.sin(i/7*Math.PI),0],'paleWood',.01);bao(bridge,[-.69,.19,0],.55);bao(bridge,[.69,.19,0],.55);}
 if(id==='front'){const duck=group('Easter egg — the smallest art critic',garden,[-4.64,.39,2.03]);orb(duck,.13,[0,.10,0],'gold',[1.2,1,1]);orb(duck,.09,[.04,.23,.03],'gold');orb(duck,.018,[.068,.25,.108],'ink');orb(duck,.052,[.07,.216,.13],'coral',[1,.4,1]);}
 k.finish();
 return{root,shade,bays,dispose:k.dispose,setShadeVisible(v){shade.visible=v;},
  residents:spec.roles.map((role,i)=>({id:role.toLowerCase(),position:[i?3.05:-3.05,.315,.74],yaw:Math.PI+(i?-.12:.12),color:spec.vests[i],headwear:spec.hats[i],pose:'standing'})),
  views:{overview:{position:[14.7,10.7,17.8],target:[0,2.0,0],shade:true},left:{position:[-4.4,5.7,2.50],target:[-3.0,1.52,-.9],shade:false},right:{position:[4.4,5.7,2.50],target:[3.0,1.52,-.9],shade:false},approach:{position:[.1,3.4,9.4],target:[0,1.70,-1.25],shade:true}}};
}
