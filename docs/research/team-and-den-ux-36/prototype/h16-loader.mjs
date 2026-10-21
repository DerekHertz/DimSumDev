// THROWAWAY loader: original module URLs keep unchanged relative import resolution.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const moduleLog='/tmp/36-h16-current-ownership-20261021-040108.modules.jsonl';
const capture=(url,result)=>{fs.appendFileSync(moduleLog,JSON.stringify({url,format:result.format,sha256:result.source===null||result.source===undefined?null:hash(result.source)})+'\n');return result;};
const manifest=JSON.parse(fs.readFileSync(new URL('./provenance.json',import.meta.url),'utf8'));
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 for(const [name,entry] of Object.entries(manifest.sources))if(url.endsWith('/scene/meshy/'+name+'.mjs')){
  if(hash(result.source)!==entry.originalSha256)throw Error('Unchanged source provenance mismatch: '+name);
  const source=fs.readFileSync(new URL(entry.overlay,import.meta.url),'utf8');
  if(hash(source)!==entry.transformedSha256)throw Error('Overlay provenance mismatch: '+name);
  return capture(url,{...result,source});
 }
 return capture(url,result);
}
