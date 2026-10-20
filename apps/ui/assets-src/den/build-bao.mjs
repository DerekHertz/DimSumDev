// Offline, deterministic reuse of the shipped Balanced Bao. No network or paid operations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as T from 'three';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const publicRoot = new URL('../../public/den/', import.meta.url);
const packed = fs.readFileSync(new URL('models/bao.glb.gz', publicRoot));
const bytes = gunzipSync(packed), jsonLength = bytes.readUInt32LE(12);
const source = JSON.parse(bytes.subarray(20, 20 + jsonLength)), bin = bytes.subarray(28 + jsonLength);
const primitive = source.meshes[0].primitives[0];
function attribute(i) {
  const a = source.accessors[i], v = source.bufferViews[a.bufferView];
  const Type = a.componentType === 5126 ? Float32Array : Uint16Array;
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const data = bin.subarray(start, start + a.count * width * Type.BYTES_PER_ELEMENT);
  return new T.BufferAttribute(new Type(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), width);
}
const original = new T.BufferGeometry();
for (const [semantic, name] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) original.setAttribute(name, attribute(primitive.attributes[semantic]));
original.setIndex(attribute(primitive.indices));
// Keep the source face topology: a uniform collapse spends its error budget on the
// nearly planar eye markings first. Body-only reduction preserves Bao's individual face.
const faceIndices = [], bodyIndices = [], p = original.attributes.position;
for (let i = 0; i < original.index.count; i += 3) {
  const ids = [original.index.getX(i), original.index.getX(i + 1), original.index.getX(i + 2)];
  const y = ids.reduce((n, k) => n + p.getY(k), 0) / 3, z = ids.reduce((n, k) => n + p.getZ(k), 0) / 3;
  const x = ids.reduce((n, k) => n + Math.abs(p.getX(k)), 0) / 3;
  (y > .35 && z > .1 && x < .55 ? faceIndices : bodyIndices).push(...ids);
}
const face = mergeVertices(original.clone().setIndex(faceIndices));
const body = mergeVertices(original.clone().setIndex(bodyIndices));
const reduced = new SimplifyModifier().modify(body, 7900);
const geometry = mergeGeometries([face, reduced]);
geometry.computeBoundingBox();
const b = geometry.boundingBox, centre = b.getCenter(new T.Vector3()), scale = 3 / (b.max.y - b.min.y);
geometry.translate(-centre.x, -b.min.y, -centre.z).scale(scale, scale, scale);
// Preserve the source's smooth normals across its UV seam duplicates. Recomputing them
// per disconnected island makes a smooth panda look like a collection of flat shards.
geometry.normalizeNormals();

const textureIndex = source.materials[0].pbrMetallicRoughness.baseColorTexture.index;
const texture = source.textures[textureIndex], imageIndex = texture.extensions?.EXT_texture_webp?.source ?? texture.source;
const view = source.bufferViews[source.images[imageIndex].bufferView];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-24-colour-'));
let pixels;
try {
  const imagePath = path.join(temporary, 'source.webp');
  fs.writeFileSync(imagePath, bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
  pixels = execFileSync('python3', ['-c', 'from PIL import Image; import sys; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGB").resize((1024,1024)).tobytes())', imagePath], { maxBuffer: 4 * 1024 * 1024 });
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
const colours = new Float32Array(geometry.attributes.position.count * 3), colour = new T.Color();
for (let i = 0; i < geometry.attributes.uv.count; i++) {
  const u = geometry.attributes.uv.getX(i), v = geometry.attributes.uv.getY(i);
  // GLTFLoader uses flipY=false: GLTF UV origin already matches the decoded image rows.
  const at = (Math.min(1023, Math.max(0, Math.floor(v * 1024))) * 1024 + Math.min(1023, Math.max(0, Math.floor(u * 1024)))) * 3;
  colour.setRGB(pixels[at] / 255, pixels[at + 1] / 255, pixels[at + 2] / 255, T.SRGBColorSpace).toArray(colours, i * 3);
}
geometry.setAttribute('color', new T.BufferAttribute(colours, 3));
geometry.deleteAttribute('uv');

function paint(g, hex) {
  const a = new Float32Array(g.attributes.position.count * 3), c = new T.Color(hex);
  for (let i = 0; i < a.length; i += 3) c.toArray(a, i);
  g.setAttribute('color', new T.BufferAttribute(a, 3)); g.deleteAttribute('uv');
  return g;
}
// A broad diagonal wrap conforms to the source torso on both sides. Ray samples are
// authoring only; the shipped garment is ordinary immutable geometry.
const positions = [], indices = [], steps = 48;
const surface = new T.Mesh(geometry, new T.MeshBasicMaterial({ side: T.DoubleSide })), ray = new T.Raycaster();
surface.updateMatrixWorld(true);
for (const side of [1, -1]) {
  const first = positions.length / 3;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = -.67 + t * 1.19, y = 1.15 + t * .88;
    for (const edge of [-1, 1]) {
      const px = x - edge * .075, py = y + edge * .1;
      ray.set(new T.Vector3(px, py, side * 3), new T.Vector3(0, 0, -side));
      const hit = ray.intersectObject(surface)[0];
      if (!hit) throw Error('Bao sash missed source torso');
      positions.push(px, py, hit.point.z + side * .09);
    }
    if (i < steps) { const n = first + i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
  }
}
const sash = new T.BufferGeometry(); sash.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); sash.setIndex(indices); sash.computeVertexNormals(); paint(sash, '#729b7e');
const pouch = paint(new RoundedBoxGeometry(.32, .34, .16, 1, .04).translate(-.55, 1.05, .76), '#746148');
const flap = paint(new RoundedBoxGeometry(.31, .13, .035, 1, .025).translate(-.55, 1.16, .86), '#8d7856');
const clothes = mergeVertices(mergeGeometries([sash.toNonIndexed(), pouch, flap]));

// Minimal self-contained GLB with baked vertex colour: no extra atlas or image decoding in the app.
const chunks = [], bufferViews = [], accessors = [];
let offset = 0;
function add(array, type, componentType, bounds) {
  const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength), padding = (4 - data.length % 4) % 4;
  const viewIndex = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
  chunks.push(data, Buffer.alloc(padding)); offset += data.length + padding;
  const index = accessors.length; accessors.push({ bufferView: viewIndex, componentType, count: array.length / ({ SCALAR: 1, VEC3: 3 }[type]), type, ...bounds }); return index;
}
function mesh(g) {
  g.computeBoundingBox();
  return { primitives: [{ attributes: {
    POSITION: add(g.attributes.position.array, 'VEC3', 5126, { min: g.boundingBox.min.toArray(), max: g.boundingBox.max.toArray() }),
    NORMAL: add(g.attributes.normal.array, 'VEC3', 5126), COLOR_0: add(g.attributes.color.array, 'VEC3', 5126),
  }, indices: add(new Uint16Array(g.index.array), 'SCALAR', 5123), material: 0 }] };
}
const meshes = [mesh(geometry), mesh(clothes)];
const gltf = { asset: { version: '2.0', generator: 'Dim Sum Dev Bao reuse / ticket24' }, scene: 0, scenes: [{ nodes: [0, 1] }],
  nodes: [{ name: 'Bao broad panda', mesh: 0 }, { name: 'Bao jade sash and pouch', mesh: 1 }], meshes,
  materials: [{ name: 'Bao matte colour blocks', doubleSided: true, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: .95 } }],
  buffers: [{ byteLength: offset }], bufferViews, accessors };
const json = Buffer.from(JSON.stringify(gltf)), paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]), binary = Buffer.concat(chunks);
const header = Buffer.alloc(20), binHeader = Buffer.alloc(8); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + paddedJson.length + binary.length, 8); header.writeUInt32LE(paddedJson.length, 12); header.write('JSON', 16); binHeader.writeUInt32LE(binary.length, 0); binHeader.write('BIN\0', 4);
const output = Buffer.concat([header, paddedJson, binHeader, binary]), compressed = gzipSync(output, { level: 9 });
fs.mkdirSync(new URL('models/characters/', publicRoot), { recursive: true });
fs.writeFileSync(new URL('models/characters/bao.glb.gz', publicRoot), compressed);
const manifestUrl = new URL('manifest.json', publicRoot), manifest = JSON.parse(fs.readFileSync(manifestUrl));
manifest.assets['characters.bao'] = { url: '/den/models/characters/bao.glb.gz', kind: 'character', characterId: 'bao', roleId: 'orchestrator', runtime: 'claude', sourceFilename: 'bao.glb.gz (local simplified reuse)', triangles: (geometry.index.count + clothes.index.count) / 3, bytes: compressed.length, decodedBytes: output.length, sha256: createHash('sha256').update(compressed).digest('hex'), compression: 'gzip', textures: [] };
manifest.bytes = Object.values(manifest.assets).reduce((n, a) => n + a.bytes, 0);
fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(new URL('bao-provenance.json', import.meta.url), JSON.stringify({
  ticket: 'team-and-den-ux/24-bao', method: 'Offline face-preserving simplification of shipped Balanced Bao; UV colour sampled to vertices; source-fitted flat jade sash and pouch; existing code rig',
  source: 'apps/ui/public/den/models/bao.glb.gz', sourceSha256: createHash('sha256').update(packed).digest('hex'),
  builder: 'apps/ui/assets-src/den/build-bao.mjs', preservedFaceTriangles: face.index.count / 3,
  meshyTasks: [], meshyCredits: 0, purchases: 0, output: manifest.assets['characters.bao'],
}, null, 2) + '\n');
console.log(JSON.stringify({ sourceSha256: createHash('sha256').update(packed).digest('hex'), ...manifest.assets['characters.bao'] }, null, 2));
