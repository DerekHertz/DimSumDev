// THROWAWAY loader: original module URLs keep unchanged relative import resolution.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const moduleLog='/tmp/36-h18-fixture-alignments-20261021-042047.modules.jsonl';
const capture=(url,result)=>{fs.appendFileSync(moduleLog,JSON.stringify({url,format:result.format,sha256:result.source===null||result.source===undefined?null:hash(result.source)})+'\n');return result;};
const manifest=JSON.parse(fs.readFileSync(new URL('./provenance.json',import.meta.url),'utf8'));
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 if(url.endsWith('/scene/meshy/actor-places.test.mjs')){
  if(hash(result.source)!=='bb8ef930b75c59ecf3db11a6209e7b286dcf6fb8ecf6019454cd217ecc3e57fb')throw Error('H18 original test-source provenance mismatch');
  const source=fs.readFileSync(new URL('./h18-actor-places.test-source.mjs',import.meta.url),'utf8');
  if(hash(source)!=='cd1abcc0cf7a653abd5b9a0a61e59ad0d507cbdc60f0c474de72fdbd3eb88776')throw Error('H18 test-source overlay provenance mismatch');
  return capture(url,{...result,source});
 }
 for(const [name,entry] of Object.entries(manifest.sources))if(url.endsWith('/scene/meshy/'+name+'.mjs')){
  if(hash(result.source)!==entry.originalSha256)throw Error('Unchanged source provenance mismatch: '+name);
  const source=fs.readFileSync(new URL(entry.overlay,import.meta.url),'utf8');
  if(hash(source)!==entry.transformedSha256)throw Error('Overlay provenance mismatch: '+name);
  return capture(url,{...result,source});
 }
 return capture(url,result);
}
