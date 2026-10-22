// Offline packaging of the ten user-picked cast sources (team-and-den-ux/25-34); never generates or spends credits.
//   node build-cast.mjs --sources <dir with NN-species-7500.glb> --out <scratch public root>          (check only)
//   node build-cast.mjs --sources <dir> --apply                                                      (write public/den + provenance)
// Source GLBs and Meshy task files stay outside the repo; only the packed *.glb.gz ships. Bao keeps build-bao.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const apply = process.argv.includes('--apply');
const sourcesDir = arg('--sources');
if (!sourcesDir) throw Error('Pass --sources with the folder holding the retained remesh GLBs; no implicit rebuild.');
const here = path.dirname(fileURLToPath(import.meta.url));
const realPublic = path.resolve(here, '../../public/den');
const outRoot = apply ? realPublic : path.resolve(arg('--out') ?? (() => { throw Error('Pass --out <scratch dir> for a check run, or --apply.'); })());
const table = JSON.parse(fs.readFileSync(path.join(here, 'cast-sources.json'), 'utf8'));

const recipe = `import sys,json,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location("pack_assets",sys.argv[1]);pack=importlib.util.module_from_spec(spec);spec.loader.exec_module(pack)
source=Path(sys.argv[2]);asset={"key":sys.argv[4],"source":source.name,"kind":"character","roleId":sys.argv[5],"maxTextureSize":512,"colorOnly":True}
record,audit=pack.pack_asset(asset,source.parent,Path(sys.argv[3]))
print(json.dumps({"record":record,"audit":audit}))`;

const outputs = {}, audits = {};
for (const c of table.characters) {
  const source = path.resolve(sourcesDir, c.sourceFilename);
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (hash !== c.sourceSha256) throw Error(`${c.characterId}: source does not match the user-picked remesh: ${hash}`);
  const packed = JSON.parse(execFileSync('python3', ['-I', '-c', recipe, path.join(here, 'pack-assets.py'), source, outRoot, 'characters.' + c.characterId, c.roleId], { encoding: 'utf8' }));
  const record = { ...packed.record, characterId: c.characterId, ...(c.runtime ? { runtime: c.runtime } : {}) };
  if (record.triangles > 8000 || record.textures.length !== 1 || record.textures[0].width > 512 || record.textures[0].height > 512) throw Error(`${c.characterId} exceeds the per-character budget`);
  outputs[c.characterId] = record; audits[c.characterId] = packed.audit;
}
console.log(JSON.stringify(outputs, null, 2));
if (!apply) { console.log('check run: nothing written outside', outRoot); process.exit(0); }

const manifestUrl = path.join(realPublic, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
for (const [id, record] of Object.entries(outputs)) manifest.assets['characters.' + id] = record;
manifest.bytes = Object.values(manifest.assets).reduce((n, a) => n + a.bytes, 0);
fs.writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(here, 'cast-provenance.json'), JSON.stringify({
  ...table, builder: 'apps/ui/assets-src/den/build-cast.mjs',
  characters: table.characters.map(c => ({ ...c, output: outputs[c.characterId], audit: audits[c.characterId] })),
}, null, 2) + '\n');
