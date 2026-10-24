import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {readGlbGeometry} from '../../../assets-src/den/read-glb-geometry.mjs';

export function teahouseProps(){
 const manifest=JSON.parse(readFileSync(new URL('../../../public/den/teahouse.json',import.meta.url)));
 return Object.fromEntries(manifest.assets.map(asset=>[asset.id,readGlbGeometry(gunzipSync(readFileSync(new URL('../../../public'+asset.url,import.meta.url))))]));
}
