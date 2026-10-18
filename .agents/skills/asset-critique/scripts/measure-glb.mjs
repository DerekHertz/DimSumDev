// Measures a skinned glb in its rest pose, per bone, so a critique can quote numbers.
// Usage: node measure-glb.mjs <file.glb> [--json]      (no dependencies; glTF space, +Y up)
//
// Each deform bone owns the vertices it weights most. For each bone:
//   length     extent of its vertices along the bone axis (head -> child joint, or -> centroid)
//   thickness  2 x the 90th-percentile distance from that axis (a robust diameter)
//   taper      thickness in five slices from head to tail, to spot "logs" (no taper)
//   reach      largest |x| of its vertices: compare with the body's to check the silhouette
import { readFileSync } from "node:fs";

const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error("usage: node measure-glb.mjs <file.glb> [--json]");
  process.exit(2);
}
const buf = readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
const bin = buf.subarray(20 + jsonLen + 8);

const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READ = {
  5121: [1, (o) => bin.readUInt8(o), 255],
  5123: [2, (o) => bin.readUInt16LE(o), 65535],
  5126: [4, (o) => bin.readFloatLE(o), 1],
};
function accessor(i) {
  const a = gltf.accessors[i];
  const view = gltf.bufferViews[a.bufferView];
  const [bytes, read, max] = READ[a.componentType];
  const n = SIZE[a.type];
  const stride = view.byteStride || bytes * n;
  const base = (view.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const row = [];
    for (let c = 0; c < n; c++) {
      const v = read(base + k * stride + c * bytes);
      row.push(a.normalized ? v / max : v);
    }
    out.push(row);
  }
  return out;
}

const skin = gltf.skins[0];
const jointNames = skin.joints.map((j) => gltf.nodes[j].name);
// Joint rest positions: the translation of each inverse-bind matrix's inverse (column-major).
const heads = accessor(skin.inverseBindMatrices).map(invertTranslation);
function invertTranslation(m) {
  // For a rigid transform [R|t], the inverse's translation is -R^T t.
  const r = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
  const t = [m[12], m[13], m[14]];
  return [0, 1, 2].map((i) => -(r[0][i] * t[0] + r[1][i] * t[1] + r[2][i] * t[2]));
}
const childOf = {};
for (const j of skin.joints) for (const c of gltf.nodes[j].children ?? []) {
  const ci = skin.joints.indexOf(c);
  if (ci >= 0 && childOf[skin.joints.indexOf(j)] === undefined) childOf[skin.joints.indexOf(j)] = ci;
}

// Gather each joint's dominant vertices across every skinned mesh.
const owned = jointNames.map(() => []);
for (const node of gltf.nodes) {
  if (node.skin === undefined || node.mesh === undefined) continue;
  for (const p of gltf.meshes[node.mesh].primitives) {
    if (p.attributes.JOINTS_0 === undefined) continue;
    const pos = accessor(p.attributes.POSITION);
    const js = accessor(p.attributes.JOINTS_0);
    const ws = accessor(p.attributes.WEIGHTS_0);
    pos.forEach((v, k) => {
      const best = ws[k].indexOf(Math.max(...ws[k]));
      if (ws[k][best] > 0.5) owned[js[k][best]].push(v);
    });
  }
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(...a);
const pct = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : 0);
const r2 = (x) => Math.round(x * 100) / 100;

const rows = [];
jointNames.forEach((name, i) => {
  const vs = owned[i];
  if (vs.length < 20) return; // sockets and unweighted joints
  const head = heads[i];
  const centroid = [0, 1, 2].map((c) => vs.reduce((s, v) => s + v[c], 0) / vs.length);
  const tail = childOf[i] !== undefined ? heads[childOf[i]] : centroid;
  const d = sub(tail, head);
  const axis = norm(d) > 1e-6 ? d.map((x) => x / norm(d)) : [0, 1, 0];
  const along = vs.map((v) => dot(sub(v, head), axis));
  const radial = vs.map((v, k) => norm(sub(sub(v, head), axis.map((a) => a * along[k]))));
  const lo = Math.min(...along), hi = Math.max(...along);
  const SLICES = 5;
  const slice = (k) => radial.filter((_, n) => along[n] >= lo + (k * (hi - lo)) / SLICES && along[n] <= lo + ((k + 1) * (hi - lo)) / SLICES);
  rows.push({
    bone: name,
    verts: vs.length,
    length: r2(hi - lo),
    thickness: r2(2 * pct(radial, 0.9)),
    taper: [0, 1, 2, 3, 4].map((k) => r2(2 * pct(slice(k), 0.9))),
    reach: r2(Math.max(...vs.map((v) => Math.abs(v[0])))),
    height: [r2(Math.min(...vs.map((v) => v[1]))), r2(Math.max(...vs.map((v) => v[1])))],
  });
});
const all = owned.flat();
const overall = {
  width: r2(2 * Math.max(...all.map((v) => Math.abs(v[0])))),
  height: r2(Math.max(...all.map((v) => v[1])) - Math.min(...all.map((v) => v[1]))),
  depth: r2(Math.max(...all.map((v) => v[2])) - Math.min(...all.map((v) => v[2]))),
};

if (flag === "--json") {
  console.log(JSON.stringify({ overall, bones: rows }, null, 2));
} else {
  console.log(`overall  width ${overall.width}  height ${overall.height}  depth ${overall.depth}`);
  console.log("bone      verts  length  thickness  taper (head -> tail)          reach |x|  height");
  for (const r of rows) {
    console.log(
      `${r.bone.padEnd(9)} ${String(r.verts).padStart(5)}  ${String(r.length).padStart(6)}  ${String(r.thickness).padStart(9)}  ` +
      `${r.taper.join(" / ").padEnd(28)}  ${String(r.reach).padStart(9)}  ${r.height.join("..")}`,
    );
  }
}
