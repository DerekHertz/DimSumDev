import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

// team-and-den-ux/25-35: structural budgets (docs/design/character-performance-method.md) for the ten cast
// characters, plus the full-cast aggregate. Rig, envelope and pose tests are in cast-rig.test.mjs, portraits in cast-portraits.test.mjs.
const manifest = JSON.parse(readFileSync(new URL('../../../public/den/manifest.json', import.meta.url))).assets;
const sources = JSON.parse(readFileSync(new URL('../../../assets-src/den/cast-sources.json', import.meta.url))).characters;

function inspect(asset) {
  const bytes = gunzipSync(readFileSync(new URL('../../../public' + asset.url, import.meta.url)));
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
  const primitives = gltf.meshes.flatMap(m => m.primitives);
  const triangles = primitives.reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0);
  const geometryBytes = gltf.bufferViews.reduce((n, v, i) => n + (gltf.images?.some(im => im.bufferView === i) ? 0 : v.byteLength), 0);
  return { gltf, primitives, triangles, geometryBytes };
}

const totals = { triangles: 0, draws: 0, geometryBytes: 0, textures: 0 };
for (const c of sources) {
  test(`${c.characterId} (${c.ticket}) ships one colour atlas inside the structural budgets`, () => {
    const asset = manifest['characters.' + c.characterId];
    assert.ok(asset, 'manifest entry (run build-cast.mjs --apply)');
    assert.equal(asset.roleId, c.roleId);
    assert.equal(asset.characterId, c.characterId);
    assert.equal(asset.runtime, c.runtime);
    const { gltf, primitives, triangles, geometryBytes } = inspect(asset);
    assert.equal(triangles, asset.triangles);
    assert.ok(triangles <= 8000, `${triangles} triangles, target 8k, cap 12k`);
    assert.ok(primitives.length <= 6, 'at most six main-pass draws');
    assert.ok(geometryBytes <= 2 * 1048576, `${geometryBytes} geometry bytes, cap 2 MiB`);
    assert.equal(asset.textures.length, 1);
    assert.deepEqual([asset.textures[0].width, asset.textures[0].height], [512, 512]);
    assert.equal((gltf.images || []).length, 1);
    for (const m of gltf.materials) {
      assert.ok(m.pbrMetallicRoughness.baseColorTexture);
      assert.equal(m.normalTexture, undefined);
      assert.equal(m.pbrMetallicRoughness.metallicRoughnessTexture, undefined);
    }
    for (const p of primitives) assert.ok(p.attributes.TEXCOORD_0 !== undefined, 'source UVs keep the face and props');
    totals.triangles += triangles; totals.draws += primitives.length; totals.geometryBytes += geometryBytes; totals.textures += 1;
  });
}

test('the whole cast stays inside the aggregate budget and matches its provenance', () => {
  assert.equal(sources.length, 10);
  assert.equal(new Set(sources.map(c => c.characterId)).size, 10);
  assert.equal(totals.textures, 10, 'each character has its own single 512 map');
  assert.ok(totals.triangles <= 10 * 8000 && totals.draws <= 10 * 6 && totals.geometryBytes <= 10 * 2 * 1048576, JSON.stringify(totals));
  const provenance = JSON.parse(readFileSync(new URL('../../../assets-src/den/cast-provenance.json', import.meta.url)));
  for (const c of provenance.characters) {
    assert.equal(c.output.sha256, manifest['characters.' + c.characterId].sha256, c.characterId + ' provenance matches the shipped file');
    assert.match(c.sourceSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(provenance.purchases, 0);
});
