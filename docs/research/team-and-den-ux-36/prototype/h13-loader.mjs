// THROWAWAY loader: original module URLs keep unchanged relative import resolution.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const manifest=JSON.parse(fs.readFileSync(new URL('./provenance.json',import.meta.url),'utf8'));
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 for(const [name,entry] of Object.entries(manifest.sources))if(url.endsWith('/scene/meshy/'+name+'.mjs')){
  if(hash(result.source)!==entry.originalSha256)throw Error('Unchanged source provenance mismatch: '+name);
  const source=fs.readFileSync(new URL(entry.overlay,import.meta.url),'utf8');
  if(hash(source)!==entry.transformedSha256)throw Error('Overlay provenance mismatch: '+name);
  return {...result,source};
 }
 return result;
}
