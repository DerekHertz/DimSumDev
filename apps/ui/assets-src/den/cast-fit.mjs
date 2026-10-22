// Offline fitting report for a cast profile (team-and-den-ux/25-35): every pose the rig test checks, with
// the worst stretched edge, its rest location and the lowest point. Envelopes are these maxima plus 5%.
// node apps/ui/assets-src/den/cast-fit.mjs <characterId>   (IT=<n> PIN=<y> override weightSmoothing)
// Every pose the test checks: worst stretch with location, envelope maxima, lowest point.
import { readFileSync } from 'node:fs'; import { gunzipSync } from 'node:zlib'; import * as T from 'three';
import { readGlbGeometry } from './read-glb-geometry.mjs';
import { createPandaAppearanceFactory } from '../../src/scene/meshy/panda-appearance.mjs';
import { createLeisureGesture } from '../../src/scene/meshy/leisure-gesture.mjs';
import * as C from '../../src/scene/meshy/cast-profiles.mjs';
const id = process.argv[2], manifest = JSON.parse(readFileSync(new URL('../../public/den/manifest.json', import.meta.url))).assets;
const src = readGlbGeometry(gunzipSync(readFileSync(new URL('../../public' + manifest['characters.' + id].url, import.meta.url))));
const profile = { ...(C.CAST_DRAFTS?.[id] || C.CAST_PROFILES[id]) }; if (process.env.IT) profile.weightSmoothing = { iterations: +process.env.IT, alpha: .5, pin: p => p.y < +(process.env.PIN || 0) };
const f = createPandaAppearanceFactory({ characters: { [id]: src }, castProfiles: { [id]: profile } }), { rig, model } = f.createPanda(profile.role, { runtime: profile.runtime }); model.scale.setScalar(1);
const g = createLeisureGesture(rig), m = rig.meshes[0], pos = m.geometry.attributes.position, idx = m.geometry.index;
const rest = Array.from({ length: pos.count }, (_, i) => new T.Vector3().fromBufferAttribute(pos, i));
const env = {}, report = [];
const poses = [];
for (const t of [0, .2, .4, .6, .8, 1]) poses.push(['walk' + t, 'moving', () => rig.poseWaddle(t)]);
for (const t of [0, 1.2, 2.4]) { poses.push(['idle' + t, 'standing', () => rig.poseIdle(t)]); poses.push(['sit' + t, 'seated', () => rig.poseSit(t)]); }
for (const k of ['tea', 'greeting', 'pond', 'mahjong']) for (const t of [.4, 1]) poses.push([k + t, 'standing', () => { rig.poseIdle(t); g.pose(k, t); }]);
for (const [label, kind, fn] of poses) {
  g.pose(null, 0); fn(); model.updateMatrixWorld(true);
  const P = rest.map((p, i) => m.applyBoneTransform(i, p.clone()));
  let worst = 0, at = null, r = 0, top = 0, low = 9, lowAt = null;
  P.forEach((p, i) => { r = Math.max(r, Math.hypot(p.x, p.z)); top = Math.max(top, p.y); if (p.y < low) { low = p.y; lowAt = rest[i].toArray().map(v => +v.toFixed(2)); } });
  for (let i = 0; i < idx.count; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) { const ai = idx.getX(i + a), bi = idx.getX(i + b), d = rest[ai].distanceTo(rest[bi]); if (d > .03) { const s = P[ai].distanceTo(P[bi]) / d; if (s > worst) { worst = s; at = rest[ai].toArray().map(v => +v.toFixed(2)); } } }
  const e = env[kind] ||= { radius: 0, height: 0, low: 9 }; e.radius = Math.max(e.radius, r); e.height = Math.max(e.height, top); e.low = Math.min(e.low, low);
  if (worst >= 3 || low < -.02 || process.env.ALL) report.push(`${label} ${worst.toFixed(1)}x at ${at} low ${low.toFixed(3)} from ${lowAt}`);
}
console.log(id, 'bones', rig.skeleton.bones.length, 'env', JSON.stringify(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, +b.toFixed(3)]))]))));
console.log(report.length ? report.join('\n') : 'all poses under 3x and above ground');
g.dispose(); f.dispose();
