// One budget spans home, overflow and staging. Exhaustion is a failed allocation,
// never permission to omit clearance or publish a place that was not reached.
export const ALLOCATION_LIMITS=Object.freeze({candidates:129,routes:32,nodes:16384,exitChecks:32768,queries:250000});
export function createAllocationWork(){
 const counts={candidates:0,routes:0,nodes:0,exitChecks:0,queries:0},cache=new Map();let exhausted=false;
 function view(limits){
  let phaseExhausted=false;
  function take(kind){
   if(phaseExhausted||exhausted)return false;
   if(counts[kind]>=ALLOCATION_LIMITS[kind]){exhausted=true;return false;}
   if(counts[kind]>=limits[kind]){phaseExhausted=true;return false;}
   counts[kind]++;return true;
  }
  return {take,get exhausted(){return phaseExhausted||exhausted;},groundAt(navigation,x,z,y,radius,height){
   if(phaseExhausted||exhausted)return null;
   // Exact keys retain height/step semantics; all phases share this cache.
   const key=JSON.stringify([x,z,y,radius,height]);if(cache.has(key))return cache.get(key);
   if(!take('queries'))return null;
   const value=navigation.groundAt(x,z,y,radius,height);if(cache.size>=32768)cache.delete(cache.keys().next().value);cache.set(key,value);return value;
  }};
 }
 // Cumulative cutoffs reserve later work without resetting any total counter.
 const work=view(ALLOCATION_LIMITS);
 work.phase=fraction=>view(Object.fromEntries(Object.entries(ALLOCATION_LIMITS).map(([kind,limit])=>[kind,Math.floor(limit*fraction)])));
 return work;
}
