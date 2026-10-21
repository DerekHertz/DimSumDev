# Approved forest Den asset pack

The 24 active models use lossless gzip storage (about 25.80 MiB). Buildings and furniture use lightweight Three.js geometry at explicit walking-world scale. The complete UI fits the unchanged 100 MiB release limit. Browser-native `DecompressionStream` restores the exact audited GLB before Three loads it; no worker, downloaded decoder, dependency or CSP exception is needed.

The 24 GLBs under `apps/ui/public/den/models/` are regular self-contained `.glb.gz` files.
The frontend loads them through `/den/manifest.json`; it does not depend on the
original prototype server, mounted Windows folders, credentials, or generation
receipts. The manifest lists public URLs, canonical role IDs, source basenames,
triangle counts, embedded texture sizes, byte counts, and SHA-256 hashes.

The pack contains the approved Balanced Bao, bamboo, the ancient grove,
all 14 original role-tool sets, and five wardrobe assets. Security reuses
the fitted Developer vest with the approved jade recolor and frog closure in
scene code. The rejected whole-panda Security generation and old hats are not
included. The detailed generated structures are retained in the original
artifact and the provenance catalog with `runtime: false`; the packager skips
them. Library, gate, kiosks, raised entrances, bamboo bridge and furniture are
now authored in `stylized-structures.mjs` and `crafted-architecture.mjs` with the
approved handcrafted-miniature detail: curved tiles, rounded timber, lattice
openings, lanterns and furnished interiors at consistent walking scale.

`role-outfits.mjs` applies Grove workwear to ten dispatchable role factories,
including the runner wardrobe prepared for resident integration. Claude uses
cream-main fabric and Codex station-colour-main fabric, with isolated materials,
role headwear and paw tools on the shared animated rig. Existing scenery roles
retain their wardrobe. Visitors and meeting copies inherit resident appearance.
`render-role-portraits.mjs` uses the same appearance factory for fifteen cached
512px WebP portraits and accepts `{runtime: 'codex'}` for offline authoring.
Grove Claude portraits are refreshed; existing scenery caches remain intact.
The profile panel uses ordinary images and creates no additional WebGL canvases.

`sources.json` is an offline provenance catalog relative to the original
artifact folder. `pack-audit.json` records source hashes, image resizing and
per-file validation. Neither file is included in the public output.

Rebuild only when the original artifact folder is available:

```sh
python3 apps/ui/assets-src/den/pack-assets.py /path/to/original-artifact-folder
python3 -m unittest discover -s apps/ui/assets-src/den -p 'test_*.py'
```

The original folder contains `bao-customizer/` and `frontend-layout-mockup/`.
Python 3 and Pillow are needed only for this offline authoring step. Normal UI
builds use the checked-in files and require no Python dependency.

## Species characters (team-and-den-ux/23)

`characters.developer` (red panda engineer) and `characters.technical-writer` (cloud
dragon writer) come from Meshy image-to-3D and remesh tasks, not the original
artifact folder; their catalog entries name `sourceRoot: meshy_output` and the task
IDs. The packager reads those two from `--meshy-output` (default: `meshy_output` at the
repo root) and everything else from the artifact folder, so a full repack needs both.
Repack just these two without touching the rest:

```sh
python3 apps/ui/assets-src/den/pack-assets.py /path/to/artifacts --meshy-output /path/to/meshy_output --only characters.developer --only characters.technical-writer
```

`colorOnly` keeps a single base colour map (at most `maxTextureSize`, 512 here),
drops normal, roughness, occlusion and emissive maps and makes the material matte;
geometry is still copied and audited exactly. The rig, weights, poses and envelopes
for both live in `src/scene/meshy/character-profiles.mjs`.

The packager preserves every vertex, normal, UV, node transform, material map,
and triangle index value. Where indices fit in 16 bits, it narrows their storage
without changing their values. Images are resized to the existing preview's
upload limits: 1,024 pixels for Bao/scenery/wardrobe and 512 for role tools.
Opaque color maps use high-quality WebP where smaller; transparency, normal and
packed PBR maps use PNG or lossless WebP. Existing JPEG maps remain JPEG when
that is the smallest encoding. WebP uses `EXT_texture_webp`, supported by the
application's bundled GLTFLoader and current browsers. Every output is reopened, image-decoded, bounds-checked, and
compared against its source geometry before the manifest is written.

Generated through the user's existing Meshy workflow and supplied source
assets; packaging itself makes no network or paid API calls.

## Bao (team-and-den-ux/24)

`characters.bao` is packed from the user-selected Meshy A remesh,
`remesh-a-7500.glb`, which is kept outside the repo:

    node apps/ui/assets-src/den/build-bao.mjs --source /path/to/remesh-a-7500.glb

The script refuses any source whose sha256 differs from the pinned one, then runs
`pack-assets.py`'s `pack_asset` with a colour-only 512² atlas (the Bao-only texture
allowance the user approved). It writes the manifest entry and
`bao-provenance.json` (source tasks, hashes, 65 Meshy credits, zero purchases). It
makes no network or paid calls.

`characters.bao` is not in `sources.json` or `pack-audit.json`, so a full base repack
drops it: run `build-bao.mjs` again **after** every repack.

The original Bao body stays shared by the other identities and is the fallback when
the Bao model fails to load.
`characters.bao` selects only the Claude orchestrator; Codex orchestrator is Jiao.
The matching portrait and its retained fallback are indexed in `role-portraits.mjs`.

Gzip compression is deterministic (zero timestamp). The audit records exact byte-for-byte decompression, alongside source geometry and image validation. All active material maps remain intact.
