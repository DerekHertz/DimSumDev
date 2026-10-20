import fs from 'node:fs';
import {createDenScene} from '../../../apps/ui/src/scene/meshy/plush/assembly.mjs';
globalThis.document={createElement:()=>({getContext:()=>new Proxy({measureText:()=>({width:40})},{get:(o,k)=>o[k]||(()=>{})})})};
const garden=createDenScene(),root=garden.root??garden;let triangles=0,shadowTriangles=0,meshes=0;
root.traverse(n=>{if(!n.isMesh||!n.visible)return;meshes++;const t=(n.geometry.index?.count??n.geometry.attributes.position.count)/3;triangles+=t;if(n.castShadow)shadowTriangles+=t;});
const result={source:'actual procedural garden assembly, before ambient/resident population; canvas text stub matches existing budget test',triangles,shadowTriangles,meshes,limits:{triangles:1800000,shadowTriangles:700000}};
fs.writeFileSync('docs/research/team-and-den-ux-22/static-garden.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));garden.dispose?.();
