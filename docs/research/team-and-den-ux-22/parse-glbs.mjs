import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
const root=path.resolve('apps/ui/public/den');
const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.relative(path.join(root,'models'),path.join(dir,e.name))]);
const files=walk(path.join(root,'models')).filter(n=>n.endsWith('.glb.gz')).sort();
const rows=files.map(file=>{
 const packed=fs.readFileSync(path.join(root,'models',file)),data=gunzipSync(packed);
 if(data.readUInt32LE(0)!==0x46546c67)throw Error('Not GLB '+file);
 const size=data.readUInt32LE(12),gltf=JSON.parse(data.subarray(20,20+size).toString('utf8'));
 const primitives=(gltf.meshes??[]).flatMap(m=>m.primitives??[]);
 const triangles=primitives.reduce((n,p)=>n+((p.mode??4)===4?(gltf.accessors[p.indices??p.attributes.POSITION]?.count??0)/3:0),0);
 return {file,compressedBytes:packed.length,decodedBytes:data.length,meshes:gltf.meshes?.length??0,primitives:primitives.length,triangles,accessors:gltf.accessors?.length??0,materials:gltf.materials?.length??0,textures:gltf.textures?.length??0,images:gltf.images?.length??0,skins:gltf.skins?.length??0,joints:(gltf.skins??[]).reduce((n,s)=>n+s.joints.length,0),animations:gltf.animations?.length??0,extensions:gltf.extensionsUsed??[]};
});
fs.writeFileSync('docs/research/team-and-den-ux-22/glb-inventory.json',JSON.stringify({source:'parsed checked-in GLB JSON chunks, not runtime scene cost',files:rows},null,2)+'\n');
console.log(JSON.stringify({files:rows.length,sourceTriangles:rows.reduce((n,r)=>n+r.triangles,0),sourceMaterials:rows.reduce((n,r)=>n+r.materials,0),skins:rows.reduce((n,r)=>n+r.skins,0),embeddedClips:rows.reduce((n,r)=>n+r.animations,0)}));
