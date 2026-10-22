// Offline: write posed vertices (idle, walk, sit, hello) for cast-grid.py to draw.
// node apps/ui/assets-src/den/cast-poses.mjs <characterId> <out-prefix>; python3 cast-grid.py <id> <png> <out-prefix>-*.json
// Dump posed vertices for rendering: idle, walk, sit, greeting.
import { readFileSync, writeFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib'; import * as T from 'three';
import { readGlbGeometry } from './read-glb-geometry.mjs';
import { createPandaAppearanceFactory } from '../../src/scene/meshy/panda-appearance.mjs';
import { createLeisureGesture } from '../../src/scene/meshy/leisure-gesture.mjs';
import * as C from '../../src/scene/meshy/cast-profiles.mjs';
const [id, out] = process.argv.slice(2), manifest = JSON.parse(readFileSync(new URL('../../public/den/manifest.json', import.meta.url))).assets;
const src = readGlbGeometry(gunzipSync(readFileSync(new URL('../../public' + manifest['characters.' + id].url, import.meta.url))));
const profile = C.CAST_DRAFTS?.[id] || C.CAST_PROFILES[id];
const f = createPandaAppearanceFactory({ characters: { [id]: src }, castProfiles: { [id]: profile } }), { rig, model } = f.createPanda(profile.role, { runtime: profile.runtime }); model.scale.setScalar(1);
const g = createLeisureGesture(rig), m = rig.meshes[0], pos = m.geometry.attributes.position;
for (const [name, fn] of [['idle', () => rig.poseIdle(0)], ['walk', () => rig.poseWaddle(.3)], ['sit', () => rig.poseSit(0)], ['hello', () => { rig.poseIdle(.3); g.pose('greeting', .3); }]]) {
  g.pose(null, 0); fn(); model.updateMatrixWorld(true);
  writeFileSync(`${out}-${name}.json`, JSON.stringify(Array.from({ length: pos.count }, (_, i) => m.applyBoneTransform(i, new T.Vector3().fromBufferAttribute(pos, i)).toArray()).flat()));
}
g.dispose(); f.dispose();
