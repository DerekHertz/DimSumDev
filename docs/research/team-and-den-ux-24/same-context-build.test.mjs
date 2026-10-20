import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sameContextTransform} from './same-context-build.mjs';
const root=new URL('../../../',import.meta.url).pathname;
test('temporary build exposes original factory, separate lookup ownership and logical clock without editing production',()=>{
 const read=p=>fs.readFileSync(root+p,'utf8');
 const world=read('apps/ui/src/scene/meshy/world.mjs'),changed=sameContextTransform(world,'/scene/meshy/world.mjs');
 assert.match(changed,/characters:originalCharacters/);assert.match(changed,/delete originalCharacters.bao/);
 assert.match(changed,/originalAppearances.createPanda\('orchestrator',\{runtime:'claude'\}\)/);
 assert.match(changed,/den.pandaRigs=new Map\(appearances.instances\)/);assert.match(changed,/den.pandaRigs.set\(panda.model,appearances.instances.get\(panda.model\)\)/);
 assert.match(changed,/den.__bao24Observer\?\.dispose\(\);originalAppearances\?\.dispose\(\);appearances\?\.dispose\(\)/);
 assert.match(changed,/resources.add\(originalAppearances.outfits\)/);
 const actors=sameContextTransform(read('apps/ui/src/scene/meshy/actors.mjs'),'/scene/meshy/actors.mjs');assert.match(actors,/__bao24State:\(\)=>\(\{time,held,selected\}\)/);
 const den=sameContextTransform(read('apps/ui/src/scene/meshy/MeshyDen.jsx'),'/scene/meshy/MeshyDen.jsx');assert.match(den,/d.__bao24Install\(agents,\(\)=>media.matches\)/);
 assert.equal(read('apps/ui/src/scene/meshy/world.mjs'),world);
 assert.throws(()=>sameContextTransform(world.replace('den.createPanda=appearances.createPanda;','different'),'/scene/meshy/world.mjs'),/Expected one/);
});
