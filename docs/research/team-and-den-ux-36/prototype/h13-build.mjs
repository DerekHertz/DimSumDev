// THROWAWAY H13 PROTOTYPE. Static text construction only: no product imports.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../../../..');
const here=import.meta.dirname,sourceRoot=path.join(root,'apps/ui/src/scene/meshy');
const manifest={base:'993523f244483f554079ece4ebb07c4c9ff8e93c',sources:{}};
const hash=s=>createHash('sha256').update(s).digest('hex');
function transform(name,fn){
 const original=fs.readFileSync(path.join(sourceRoot,name+'.mjs'),'utf8');let source=original;
 const edit=(before,after)=>{const n=source.split(before).length-1;if(n!==1)throw Error(name+': anchor count '+n+' '+before);source=source.replace(before,after);};
 fn(edit,()=>source);fs.writeFileSync(path.join(here,name+'.prototype.mjs'),source);
 manifest.sources[name]={originalSha256:hash(original),transformedSha256:hash(source),original:'apps/ui/src/scene/meshy/'+name+'.mjs',overlay:name+'.prototype.mjs'};
}
transform('actor-places',(edit)=>{
 edit("{speed,getActors:()=>[...actors.values()]}","{speed,getActors:()=>[...actors.values()],proveRoute:(a,p,w)=>proveTrip(a,p,w)}");
 edit(' const exits=new Map();',' const exits=new Map(),pendingWorks=new WeakMap();\n'+fs.readFileSync(path.join(here,'trip-body.txt'),'utf8'));
 edit(" function prepare(a,kind='work',near=a.home,{arrival=false}={}){", " function prepare(a,kind='work',near=a.home,{arrival=false}={}){globalThis.__h13Observe?.('prepare-start',{a,arrival});");
 edit("const prior=[...exits].filter(([b])=>b!==a&&b.panda.model.visible).map(([b,e])=>({owner:b.identity,from:point(e.from),path:e.path.map(point),radius:e.radius}));", "const prior=[...exits].filter(([b])=>b!==a&&b.panda.model.visible).flatMap(([b,e])=>[{owner:b.identity,from:point(e.from),path:e.path.map(point),radius:e.radius},...(e.active??[]).map(p=>({owner:b.identity,from:point(p.from),path:p.path.map(point),radius:e.radius}))]);");
 edit('let landing=a.approach?null:findLanding(),exit;', 'let landing=null,exit;');
 edit('const preservesExits=position=>physical.prior.every(old=>!crosses(position,old.path,old.from,a.envelope.radius+old.radius+.03,work));', "const preservesExits=position=>{const result=physical.prior.every(old=>!crosses(position,old.path,old.from,a.envelope.radius+old.radius+.05,work));if(!result)globalThis.__h13Observe?.('prepare-rejection',{a,reason:'prior-protected-corridor',position:point(position),work});return result;};");
 edit('   const goal=a.approach??landing?.place.position;if(!goal)return false;', '   if(!a.approach){const local=outgoing(position,staging,position);if(!local)return false;exit=local;return true;}\n   const goal=a.approach;');
 edit('if(!local)return false;exit=local;', "if(!local){globalThis.__h13Observe?.('prepare-rejection',{a,reason:'no-local-two-way-anchor',position:point(position),work});return false;}exit=local;");
 edit("let home=(a.approach||landing)?places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,validate:accessible,work}):null;", "let home=places.find({id:'home:'+a.id,kind,near,owner:a.identity,envelope:a.envelope,validate:accessible,work});");
 edit("a.panda.model.visible=false;return false;", "a.panda.model.visible=false;globalThis.__h13Observe?.('prepare-failed',{a,work});return false;");
 edit("exits.set(a,{from:point(a.home),path:exit.map(point),radius:a.envelope.radius});", "exits.set(a,{from:point(a.home),path:exit.map(point),radius:a.envelope.radius,active:[]});globalThis.__h13Observe?.('local-certificate',{a,from:point(a.home),path:exit.map(point),work});");
 edit('  return true;\n }\n function go', "  globalThis.__h13Observe?.('prepare-complete',{a,work});return true;\n }\n function go");
 edit('  traveller.request(a,place.id,work);sync(a);return a.travel.status!==\'unavailable\';', `  work??=pendingWorks.get(a)??createAllocationWork();pendingWorks.delete(a);
  const prior=a.travel,certificate=exits.get(a),oldActive=certificate?.active;
  const response=traveller.request(a,place.id,work);
  if(!['moving','arrived'].includes(response?.status)){a.travel=prior;if(certificate)certificate.active=oldActive;if(place.id!==a.homePlace)places.release(place.id,a.identity);a.presentation='Scene destination unavailable';globalThis.__h13Observe?.('trip-rejected',{a,work});return false;}
  sync(a);return true;`);
 edit('function home(a){return go(a,places.get(a.homePlace));}', "function home(a){const ok=go(a,places.get(a.homePlace));if(!ok&&a.travel){a.travel.returnRequested=true;a.travel.status='waiting';a.travel.retryAt=Infinity;const e=exits.get(a);if(e){e.failedDependency=dependency(a);e.failedGroundAt=den.walkWorld.navigation.groundAt;globalThis.__h13Observe?.('retained-return',{a,from:e.from,local:e.path,active:e.active});}}return ok;}");
 edit("  if(kind==='leisure')return places.find({id,kind,near:position,owner:a.identity,envelope:a.envelope});", "  const work=createAllocationWork();pendingWorks.set(a,work);\n  if(kind==='leisure')return places.find({id,kind,near:position,owner:a.identity,envelope:a.envelope,work,validate:p=>preservesProtected(a,p,work)});");
 edit('if(places.reserve(id,a.identity,a.envelope))return exact;', 'if(preservesProtected(a,position,work)&&places.reserve(id,a.identity,a.envelope,work))return exact;');
 edit("places.find({id:id+':'+a.id,kind,near:position,owner:a.identity,envelope:a.envelope})", "places.find({id:id+':'+a.id,kind,near:position,owner:a.identity,envelope:a.envelope,work,validate:p=>preservesProtected(a,p,work)})");
 edit("  const t=a.travel;a.path=t?.path?.length?t.path:null;", "  const t=a.travel;if(t?.status==='arrived'&&t.placeId===a.homePlace){const e=exits.get(a);if(e)e.active=[];places.cancel(a.identity,a.homePlace);globalThis.__h13Observe?.('home-arrival',{a});}a.path=t?.path?.length?t.path:null;");
 edit('update(dt,reduced,held){traveller.update', 'update(dt,reduced,held){revalidateTrips();traveller.update');
});
transform('actor-travel',(edit)=>{
 edit('getActors=()=>[]}={}', 'getActors=()=>[],proveRoute=null}={}');
 edit("  if(a.travel&&a.travel.placeId!==a.homePlace)places.release(a.travel.placeId,owner(a));\n  a.travel={placeId,path:[],attempts:0,status:'waiting',retryAt:time};attempt(a,work);return a.travel;", `  if(proveRoute){const p=places.get(placeId),proof=p&&proveRoute(a,p,work);if(!proof)return {status:'unavailable'};if(a.travel&&a.travel.placeId!==a.homePlace)places.release(a.travel.placeId,owner(a));a.travel={placeId,path:proof,attempts:1,status:'moving',retryAt:time+8};return a.travel;}
  if(a.travel&&a.travel.placeId!==a.homePlace)places.release(a.travel.placeId,owner(a));
  a.travel={placeId,path:[],attempts:0,status:'waiting',retryAt:time};attempt(a,work);return a.travel;`);
 edit("  else{const obstacles=", "  else if(proveRoute){const proof=proveRoute(a,p,work);t.path=proof??[];t.status=t.path.length?'moving':'waiting';}\n  else{const obstacles=");
 edit('   let y=routeSegment(world,p,to,a.envelope);', "   const motionWorld={...world,obstacles:[...(world.obstacles??[]),...[...places.values()].filter(q=>q.owner&&q.owner!==owner(a)).map(q=>({...q.position,type:'circle',radius:q.envelope.radius+.05}))]};\n   let y=routeSegment(motionWorld,p,to,a.envelope);");
 edit('y=routeSegment(world,from,next,a.envelope);','y=routeSegment(motionWorld,from,next,a.envelope);');
 edit('const detour=gardenRoute({...world,obstacles},p,destination.position,a.envelope);', 'const detour=proveRoute?(proveRoute(a,destination,null)??[]):gardenRoute({...world,obstacles},p,destination.position,a.envelope);');
});
transform('allocation-work',(edit)=>{
 edit('let exhausted=false;', 'let exhausted=false;const navigationKeys=new WeakMap();let navigationSerial=0;');
 edit('const key=JSON.stringify([navigation.revision??null,x,z,y,radius,height]);', 'if(!navigationKeys.has(navigation.groundAt))navigationKeys.set(navigation.groundAt,++navigationSerial);const key=JSON.stringify([navigationKeys.get(navigation.groundAt),navigation.revision??null,x,z,y,radius,height]);');
 edit('  return {take,get exhausted()', '  const result={take,get exhausted()');
 edit('  }};', "  }};globalThis.__h13Observe?.('work-view',{work:result,read:()=>({counts:{...counts},limits:{...limits},phaseExhausted,exhausted,cacheSize:cache.size})});return result;");
 edit('{exhausted=true;return false;}', "{exhausted=true;globalThis.__h13Observe?.('work-cutoff',{kind,counts:{...counts},limits:{...limits},scope:'global'});return false;}");
 edit('{phaseExhausted=true;return false;}', "{phaseExhausted=true;globalThis.__h13Observe?.('work-cutoff',{kind,counts:{...counts},limits:{...limits},scope:'phase'});return false;}");
});
transform('places',(edit)=>{
 edit('if(y===null||Math.abs(y-position.y)>.1)return false;', "if(y===null||Math.abs(y-position.y)>.1){globalThis.__h13Observe?.('registry-fit-rejected',{owner,position,reason:'ground-or-height'});return false;}");
 edit("if(world.obstacles?.some(o=>o.type==='circle'&&distance(position,o)<o.radius+envelope.radius))return false;", "if(world.obstacles?.some(o=>o.type==='circle'&&distance(position,o)<o.radius+envelope.radius)){globalThis.__h13Observe?.('registry-fit-rejected',{owner,position,reason:'solid-obstacle'});return false;}");
 edit('if(getBodies().some(b=>b.owner!==owner&&distance(position,b.position)<envelope.radius+b.envelope.radius+.03))return false;', "if(getBodies().some(b=>b.owner!==owner&&distance(position,b.position)<envelope.radius+b.envelope.radius+.03)){globalThis.__h13Observe?.('registry-fit-rejected',{owner,position,reason:'current-body'});return false;}");
 edit('return ![...places.values()].some(p=>p.id!==ignore&&p.owner&&p.owner!==owner&&distance(position,p.position)<envelope.radius+p.envelope.radius+.05);', "const fit=![...places.values()].some(p=>p.id!==ignore&&p.owner&&p.owner!==owner&&distance(position,p.position)<envelope.radius+p.envelope.radius+.05);if(!fit)globalThis.__h13Observe?.('registry-fit-rejected',{owner,position,reason:'foreign-owned-lease'});return fit;");
});
transform('actors',(edit)=>{
 edit('export function createMeshyActors(den){', "export function createMeshyActors(den){globalThis.__h13Observe?.('world-ready',{den});");
});
const originalTest=fs.readFileSync(path.join(sourceRoot,'actors.test.mjs'),'utf8');
const fixture=originalTest.slice(originalTest.indexOf('function fixture(){'),originalTest.indexOf("test('visitors retain"));
fs.writeFileSync(path.join(here,'fixture.prototype.mjs'),`// THROWAWAY: exact original fixture body; imports point to unchanged product modules.\nimport * as T from 'three';\nimport {createBalancedPandaRig} from '${path.join(sourceRoot,'panda-rig.mjs')}';\nimport {RESIDENTS as definitions} from '${path.join(root,'apps/ui/src/shell/resident-inventory.mjs')}';\nimport {createMeshyActors} from '${path.join(sourceRoot,'actors.mjs')}';\nexport ${fixture}`);
manifest.fixture={original:'apps/ui/src/scene/meshy/actors.test.mjs',originalSha256:hash(originalTest),exactFixtureBodySha256:hash(fixture)};
fs.writeFileSync(path.join(here,'provenance.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({staticConstruction:true,base:manifest.base,transformed:Object.keys(manifest.sources),fixtureBodySha256:hash(fixture)}));
