// Offline sweep of a planted-feet crouch depth for a cast profile: stretch and lowest point per drop.
// node apps/ui/assets-src/den/cast-sit-sweep.mjs <characterId>
import { readFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib'; import * as T from 'three';
import { readGlbGeometry } from './read-glb-geometry.mjs';
import { createPandaAppearanceFactory } from '../../src/scene/meshy/panda-appearance.mjs';
import * as C from '../../src/scene/meshy/cast-profiles.mjs';
const id = process.argv[2], manifest = JSON.parse(readFileSync(new URL('../../public/den/manifest.json', import.meta.url))).assets;
const src = readGlbGeometry(gunzipSync(readFileSync(new URL('../../public' + manifest['characters.' + id].url, import.meta.url))));
const profile = { ...(C.CAST_DRAFTS?.[id] || C.CAST_PROFILES[id]), sit: { drop: 0, hip: 0, knee: 0, splay: 0, planted: true } }; if (process.env.IT) profile.weightSmoothing = { iterations: +process.env.IT, alpha: .5, pin: p => p.y < +(process.env.PIN || 0) };
const f = createPandaAppearanceFactory({ characters: { [id]: src }, castProfiles: { [id]: profile } }), { rig, model } = f.createPanda(profile.role, { runtime: profile.runtime }); model.scale.setScalar(1);
const m = rig.meshes[0], pos = m.geometry.attributes.position, idx = m.geometry.index, rest = Array.from({ length: pos.count }, (_, i) => new T.Vector3().fromBufferAttribute(pos, i));
const rows = [];
for (const hip of [0]) for (const knee of [0]) for (const splay of [0]) for (const drop of [0, .03, .06, .1, .15, .2, .25]) {
  Object.assign(rig.profile.sit, { hip, knee, splay, drop }); rig.poseSit(0, { reducedMotion: true }); model.updateMatrixWorld(true);
  const P = rest.map((p, i) => m.applyBoneTransform(i, p.clone())); let worst = 0, low = 9, top = 0;
  for (const p of P) { low = Math.min(low, p.y); top = Math.max(top, p.y); }
  for (let i = 0; i < idx.count; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const ai = idx.getX(i + a), bi = idx.getX(i + b), d = rest[ai].distanceTo(rest[bi]); if (d > .03) worst = Math.max(worst, P[ai].distanceTo(P[bi]) / d); }
  // Pelvis height sets how deep the seat is; we want the deepest sit with stretch < 3 and nothing below -.02.
  rows.push({ hip, knee, splay, drop, worst: +worst.toFixed(2), low: +low.toFixed(3), top: +top.toFixed(2) });
}
0&&rows.sort((a, b) => Math.max(a.worst / 3, -a.low / .02) - Math.max(b.worst / 3, -b.low / .02)); console.log(id, rows.length, 'passing'); for (const r of rows.slice(0, 8)) console.log(JSON.stringify(r));
f.dispose();
