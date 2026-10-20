# Team and Den UX 22: cast and asset inventory

Scope: inventory of the merged base at `origin/main` commit `8b3172d`. Runtime facts below come from source and checked-in package metadata, not approved concept art. No assets were generated or modified.

## Cast and identity mapping

- `resident-inventory.mjs` defines 15 roles: orchestrator, product, architect, developer, scout, runner, qa, security, designer, herald, debugger, release-manager, knowledge-keeper, docs-writer, stem-cub. The ten `DISPATCHABLE_ROLES` have Claude and Codex residents (20); the other five have Claude only, for 25 resident identity rows total. Runtime ID is the bare role for Claude and `codex:<role>` for Codex; Codex's orchestrator displays as Jiao. See [resident-inventory.mjs](../../../apps/ui/src/shell/resident-inventory.mjs#L1).
- `residentHomes()` maps residents onto active garden team props and computes separate Claude/Codex positions for dispatchable roles. Orchestrator copies flank the center. Role teams and homes are explicit in [resident-homes.mjs](../../../apps/ui/src/scene/meshy/resident-homes.mjs#L1).
- Every actor body is created from the same checked-in `bao` character GLB. `createBalancedPandaRig()` builds a new independent skeleton/skinned mesh instance for each resident, visitor, meeting stand-in, and ambient panda. Role/runtime distinction is procedural appearance and outfit, not a unique body mesh; see [world.mjs](../../../apps/ui/src/scene/meshy/world.mjs#L16), [panda-rig.mjs](../../../apps/ui/src/scene/meshy/panda-rig.mjs#L91), [actors.mjs](../../../apps/ui/src/scene/meshy/actors.mjs#L17).
- Role outfits are fixed by role and include vest/scarf, headwear and role accessories. Codex and Claude share role templates but runtime-specific grove palettes/accessories can differ. The resident runtime is carried into outfit creation. See [role-outfits.mjs](../../../apps/ui/src/scene/meshy/role-outfits.mjs#L6) and [panda-appearance.mjs](../../../apps/ui/src/scene/meshy/panda-appearance.mjs#L8).
- Profile portraits are separate static WebP files, selected by role and runtime (`codex:<role>` when applicable); the tree includes portraits for the 15 Claude roles and ten dispatchable Codex roles. See [role-portraits.mjs](../../../apps/ui/src/shell/role-portraits.mjs#L1) and [Residents.jsx](../../../apps/ui/src/shell/Residents.jsx#L11).
- Newer/retired-from-dispatch roles debugger, release-manager, knowledge-keeper, docs-writer, and stem-cub remain residents and have portraits, role outfits/tools, and role prop GLBs. Their inventory is UI presentation membership; only roles in `LIVE_ROLES` bind live agents. Additional roles in `RESIDENTS` are not automatically active runtime actors unless they have home definitions and scene setup.
- Live duplicate agents become visitor copies using the same role/runtime identity and independent rig. Meeting seats use an idle resident when free; if busy, a temporary copy sits at the table while the working resident continues. See [actors.mjs](../../../apps/ui/src/scene/meshy/actors.mjs#L34) and [actors.mjs](../../../apps/ui/src/scene/meshy/actors.mjs#L60).

## Motion, garments, props, attachments, scenery

- GLBs contain geometry/materials/textures but current character animation is procedural: `poseIdle`, `poseWaddle`, role leisure gestures, actor path travel, and ambient routine poses manipulate the rig's named bones. No embedded animation clips are played by the runtime. See [panda-rig.mjs](../../../apps/ui/src/scene/meshy/panda-rig.mjs#L170), [actors.mjs](../../../apps/ui/src/scene/meshy/actors.mjs#L91), [leisure-gesture.mjs](../../../apps/ui/src/scene/meshy/leisure-gesture.mjs#L4), [ambient-garden.mjs](../../../apps/ui/src/scene/meshy/ambient-garden.mjs#L46).
- Character-worn vest/scarf/headphones are fitted from downloaded GLB wardrobe sources; security vest is a fitted/tinted derivative of developer vest. Boba and tablet wardrobe assets are catalogued but installed as desktop accessories, not worn; fitting tests or role-tools supply some additional procedural paw props. `world.mjs` loads Bao, developer vest, QA scarf, and developer headphones for the scene, not every manifest asset.
- Fourteen role-specific prop GLBs exist (one per resident role except no missing role): these are separate concept props, not character bodies. Actual scene wiring should be checked before assuming every package prop is attached to a panda; role tool code procedurally supplies tool-like attachments, while current garden role workspaces are procedural.
- Vegetation GLBs are bamboo and ancient grove. The rest of the garden, structures, interactive scenery, desks and meeting table are built through procedural Three.js assembly. `createMeshyWorld()` adds ambient panda residents and procedural fixtures.
- Reuse limit for red-panda engineer / cloud-dragon writer: the scene supports role/runtime variants atop one panda body, with current engineer developer vest/headphones and writer scarf/headwear/tool semantics. An alternate species/body requires a new fitted source mesh plus compatible rig weights/skeleton and a valid appearance/outfit path; simply swapping a portrait or role prop does not create a distinct rigged character. Existing writer/developer role props are discrete props, not full replacement actors. No runtime-specific animated GLB clips are currently used.

## Checked-in model package

`apps/ui/public/den/manifest.json` is the package inventory and records compressed byte size (`bytes`), decoded GLB bytes, triangle count and texture count/dimensions. `rg --files apps/ui/public/den/models` confirms 22 `.glb.gz` files: 1 character, 14 props, 5 wardrobe items, 2 vegetation assets. Totals by category:

| Kind | Count | Triangles | Compressed bytes | Decoded bytes |
|---|---:|---:|---:|---:|
| Character (Bao) | 1 | 20,786 | 941,948 | 1,066,656 |
| Role props | 14 | 839,818 | 20,870,429 | 25,744,912 |
| Wardrobe | 5 | 17,087 | 831,227 | 1,155,764 |
| Vegetation | 2 | 61,724 | 3,759,994 | 5,013,660 |
| Total | 22 | 939,415 | 26,403,598 | 32,980,992 |

Per-file manifest metadata includes `triangles`, compressed `bytes`, `decodedBytes`, and `textures`; the source package mapping is [sources.json](../../../apps/ui/assets-src/den/sources.json). Bao: 20,786 triangles, 2 textures, 941,948 compressed bytes. Role props: roughly 59,942–60,000 triangles each and three textures each. Wardrobe: 1,295–6,034 triangles and one texture each. Vegetation: 30,613/31,111 triangles, with three/one textures. The parsed [GLB inventory](./glb-inventory.json) reports 22 files, each with one mesh/primitive/material; 0 source skins, joints, and animation clips. Bao is consumed as source geometry to generate a runtime skin with 26 bones; this runtime-created rig does not mean the source GLB has a skin, joints, or clips. Per-file accessor and image details are in the parsed inventory.

## Approved principal designs versus legacy runtime actors

The approved character plan is 13 principal designs: Bao and Jiao as the two hosts, plus 11 current roles: product, architect, developer/engineer, qa, security, designer, release manager, SRE, technical writer, code reviewer, and runner. `docs/agents/team-charter.md` names Bao/Jiao as executives, retires orchestrator/herald/scout, and folds scout into runner's read-only mode. This design list is not the active actor count or a claim that all 13 designs are seated.

The current runtime still exports 15 legacy IDs: orchestrator, product, architect, developer, scout, runner, qa, security, designer, herald, debugger, release-manager, knowledge-keeper, docs-writer, and stem-cub. Ten roles are dispatchable in both Claude and Codex (20 identity rows); five scenery roles are Claude-only, for 25 residents total. Actual principal-to-legacy mapping/status:

| Approved principal design | Current resident/runtime mapping |
|---|---|
| Bao | `orchestrator` (Claude) |
| Jiao | `codex:orchestrator` |
| product | `product` |
| architect | `architect` |
| developer / engineer | `developer` (displayed “Maker”) |
| qa | `qa` |
| security | `security` |
| designer | `designer` |
| release manager | legacy `release-manager` (“The Drummer”), scenery-only and non-dispatchable; the dispatchable charter seat is not implemented |
| SRE | no resident; awaiting seat |
| technical writer | legacy `docs-writer` (“The Painter”), scenery-only and non-dispatchable; the charter seat is not implemented |
| code reviewer | no resident; awaiting seat |
| runner | `runner` (dispatchable in both runtimes) |

Legacy `scout` and `herald` remain dispatchable despite their retirement in the charter; `debugger`, `knowledge-keeper`, and `stem-cub` are additional scenery residents. `paired-residents.test.mjs` explicitly marks code reviewer, release manager, SRE, and technical writer as awaiting seats and comments that team-and-den-ux/03 drops the placeholder list. `proximity-card.mjs` already lists these four as start roles, which is not evidence of resident seating. Sources: [team charter](../../agents/team-charter.md#L7), [resident inventory](../../../apps/ui/src/shell/resident-inventory.mjs#L1), [paired resident mapping test](../../../apps/ui/src/shell/paired-residents.test.mjs#L8), and [start-role list](../../../apps/ui/src/overlay/proximity-card.mjs#L7).

## Window/navigation shell in this base

The signed-off team-and-den-ux/04 design specifies a 44px topbar, a left rail that is 56px collapsed / 200px expanded, 440px topic sheets and 400px side sheets, with the scene full-viewport. The checked-in [App.jsx](../../../apps/ui/src/App.jsx#L271) instead has an existing masthead navigation row (“The Den,” “Work,” “Pandas,” “Library”) above a welcome section and an inset `Den scene` workspace; its presence does not establish that the approved full-window 04 shell landed. [forest.css](../../../apps/ui/src/shell/forest.css#L1) styles this forest shell and does not establish the signed-off geometry. At base commit `8b3172d` (`ui-rename-04`), ADR 0028 itself says the 04 terminology rename was done “ahead of its full-window shell.” Therefore this merged base contains the rename portion; the approved full-window 04 layout is not present here, consistent with the board’s full-window 04 ticket still being in review. The report is based on source at this commit; board status is a separately supplied project fact.

## Unknowns / limits

- GLB primitive/material/accessor/skin/joint/clip counts are parsed in [glb-inventory.json](./glb-inventory.json); all files have one primitive/material and zero source skins, joints, or clips. The 26-bone character rig is generated at runtime.
- Role-prop GLBs are present in the package, but this review did not prove every one is loaded into the active scene; `createMeshyWorld()` explicitly loads only Bao plus three wardrobe sources for character construction.
- The active cast path creates an explicit role tool and attaches it to `paw_R`; role-prop GLBs remain package assets and are not the visible actor-hand props in that factory. See [panda-appearance.mjs](../../../apps/ui/src/scene/meshy/panda-appearance.mjs#L8). No visual claim is made about species likeness or whether the approved art matches runtime assembly.
