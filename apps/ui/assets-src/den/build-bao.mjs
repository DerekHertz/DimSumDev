// Offline packaging of user-selected Meshy A; never generates or spends credits.
// node apps/ui/assets-src/den/build-bao.mjs --source /path/to/remesh-a-7500.glb
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const expected = '2f246951113c8824c69063c49ab6a3f9a7d833688db79aef26fdc36d73f3ed38';
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) throw Error('Pass --source with the retained selected-A remesh GLB; no implicit legacy rebuild.');
const source = path.resolve(process.argv[sourceIndex + 1]);
const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
if (hash !== expected) throw Error('Source does not match the user-selected A remesh: ' + hash);
const here = path.dirname(fileURLToPath(import.meta.url)), publicRoot = path.resolve(here, '../../public/den');
const recipe = `import sys,json,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location("pack_assets",sys.argv[1]);pack=importlib.util.module_from_spec(spec);spec.loader.exec_module(pack)
source=Path(sys.argv[2]);asset={"key":"characters.bao","source":source.name,"kind":"character","roleId":"orchestrator","maxTextureSize":512,"colorOnly":True}
record,audit=pack.pack_asset(asset,source.parent,Path(sys.argv[3]))
print(json.dumps({"record":record,"audit":audit}))`;
const packed = JSON.parse(execFileSync('python3', ['-c', recipe, path.join(here,'pack-assets.py'), source, publicRoot], {encoding:'utf8'}));
const output = {...packed.record, characterId:'bao', runtime:'claude'};
if(output.triangles>8000 || output.textures.length!==1 || output.textures[0].width>512 || output.textures[0].height>512) throw Error('Selected-A package exceeds Bao budget');
const manifestUrl = path.join(publicRoot,'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestUrl));
manifest.assets['characters.bao']=output;manifest.bytes=Object.values(manifest.assets).reduce((n,a)=>n+a.bytes,0);
fs.writeFileSync(manifestUrl,JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(here,'bao-provenance.json'),JSON.stringify({
  ticket:'team-and-den-ux/24-bao',method:'User-selected Meshy A; triangle remesh; proven23 colour-only 512px atlas packer; local shared code rig',
  selectedSourceTask:'01a15a76-e214-75bf-a510-25c77230a8a2',remeshTask:'01a15a82-843f-740c-a650-be1b2ad33877',
  sourceFilename:path.basename(source),sourceSha256:hash,builder:'apps/ui/assets-src/den/build-bao.mjs',
  meshyCredits:65,purchases:0,output,audit:packed.audit,
},null,2)+'\n');
console.log(JSON.stringify(output,null,2));
