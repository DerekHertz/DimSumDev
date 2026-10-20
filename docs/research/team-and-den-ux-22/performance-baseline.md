# Reference-GPU baseline for cast work

Measured on **2026-10-19 (America/Los_Angeles)**. This is a fresh hardware-rendered baseline of source commit **8b3172df7c9032062c936f6dd04c2f12ffb99cc0**, compiled in production mode with two observation-only hooks. **It is not a measurement of replacement characters or the currently installed release.**

## Reference and versions

| Item | Recorded value |
|---|---|
| GPU / driver / VRAM | RTX 3060 Ti / 617.42 / 8,192 MiB |
| CPU / physical RAM | Ryzen 7 5800X, 8 cores / 16 logical processors; 17,101,971,456 bytes (about 16 GiB) |
| Browser | Native Windows Chrome 155.0.8059.84, headless, isolated temporary profile |
| WebGL | ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x000024C9) Direct3D11 vs_5_0 ps_5_0, D3D11); WebGL2 + disjoint timer-query extension verified |
| Source build | 8b3172df7c9032062c936f6dd04c2f12ffb99cc0; optimized Vite production build, real draws, no lightenScene/SwiftShader |
| Installed den | v0.1.7 / 14b615d73dc0dcbb7a8596a0976619c7ea3a1206; built 2026-10-19; service unchanged |
| Viewport / DPR / actual scene surface | 1440×900 / 1 / 980×483 CSS and drawing-buffer pixels in this existing inset shell |
| Capture | 4-second warm-up after ready, then 12 seconds per scenario; 30 fps cap preserved |
| Actor fixture | 25 resident identities; +4 same-role/runtime visitors; +6 busy-role meeting stand-ins; **15 additional ambient bodies always present** |
| Input/side effects | Local synthetic read-only state and event routes, no agent launches; **0 non-GET requests and 0 page exceptions** |

This base includes the merged 04 terminology rename, **not the signed-off full-window shell**. Source App/forest.css still render the inset scene, and the board's full-window ticket remains in review. The user's statement that 04 is merged is recorded; the identifiable merge on origin/main is ui-rename-04. Inventory can proceed independently, but refresh this baseline when the actual 44px bar/left-rail/full-window canvas and 03 seats land. A larger canvas/DPR can materially change raster cost. Do not apply these timings to a full-window canvas without measuring it. The installed source also differs from this checkout; recording its metadata is not a claim its running UI was benchmarked.

## Measured frame/resource table

Bodies column is role/resident/visitor actors **plus ambient actors**. CPU values are main-thread spans; GPU values are asynchronous WebGL timer-query samples every third render. Frame interval is time between renderer calls under the cap, not GPU work time. CPU/GPU spans overlap: do not add the columns as if serial.

| Scenario | Bodies | FPS | Frame interval p95 ms | GPU p95 ms | Render CPU p95 ms | Animation CPU p95 ms | Median main render calls | End JS heap MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| idle-light | 25+15 | 29.83 | 33.9 | 10.14 | 11.9 | 1.6 | 1,332 | 379.8 |
| idle-dark | 25+15 | 29.83 | 33.8 | 9.81 | 11.6 | 1.6 | 1,332 | 380.9 |
| crowded-light | 29+15 | 29.88 | 33.9 | 10.63 | 13.3 | 1.8 | 1,410 | 395.7 |
| crowded-dark | 29+15 | 29.88 | 33.8 | 11.06 | 13.2 | 1.8 | 1,410 | 385.9 |
| meeting-light | 35+15 | 29.88 | 34 | 4.56 | 13 | 2.1 | 1,519 | 397.8 |
| meeting-dark | 35+15 | 29.83 | 33.9 | 4.54 | 13.8 | 2.1 | 1,519 | 409.7 |
| walk-light | 29+15 | 29.83 | 33.9 | 10.1 | 11.6 | 1.7 | 1,222 | 398.3 |
| walk-dark | 29+15 | 29.88 | 33.9 | 10.24 | 11.6 | 1.8 | 1,222 | 396.1 |
| reduced-light | 35+15 | 30 | 33.9 | 13.77 | 15 | 1.6 | 1,515 | 418.4 |
| reduced-dark | 35+15 | 29.96 | 33.9 | 11.64 | 13.6 | 1.5 | 1,515 | 388.7 |

Animation CPU sums each frame's wrapped actor update, ambient pose and koi update; it excludes other React/DOM/camera work. Dark mode uses the application's current color-scheme treatment; scene lights remain the current shared daytime rig, not a new dusk design. Walking scenarios really use a PerspectiveCamera and hold W for the sample; all other views retain the current overview camera. Raw camera transforms are preserved. Meeting stand-ins are presentation actors, not additional agent executions.

## Geometry, textures, shadows and memory

- Fresh static procedural garden, before population: **1,772,169 triangles**, **477,576 potential shadow-casting triangles**, 745 meshes. Existing guards are unchanged at <1.8M / <700k; both existing tests passed.
- Idle assembled scene: **3,011,549 structural triangles**. Resident subtree: **798,340**, with 25 role actors. Fifteen ambient pandas add **418,672**; populated garden measurements include those ambient models and small integration additions. Do not misreport populated-garden triangles as a garden-guard failure.
- The 35-role-actor meeting fixture has **1,135,700 role triangles**, plus the same 15 ambient bodies. More actor instances cost real geometry/skin/draw work even when a scene still reports 30 fps.
- Idle unique geometry buffers: **253.89 MiB**; material-referenced RGBA texture+mipmap estimate: **64.8 MiB**. These estimates deduplicate geometry objects, attribute buffers within each geometry, and texture UUIDs; buffers shared across distinct geometry objects can be overcounted; they are not exact driver allocation, resident VRAM, total process RAM or all retained loader/template resources. JS heap comes from Chrome performance.memory.
- Shadow triangles describe eligible geometry, not a second copy of every triangle submitted every frame. Preserve current cached shadow/update behavior when comparing. Actual renderer.info calls/triangles can vary with camera culling and passes; raw values accompany structural totals.
- All 22 packaged GLBs were parsed directly: **939,415 source triangles**, one mesh primitive/material per file, **0 source skins, 0 source joints and 0 embedded animation clips**. Package totals are not simultaneous render cost: only Bao and three wardrobe sources are loaded for current character construction, with procedural scenery/tools. See [GLB inventory](./glb-inventory.json).

## Per-role instance costs and current posed bounds

Mesh/material counts are actual assembled actor subtree counts, not promises that every material is visible from every camera. Bounds include current clothes/tools in the sampled idle pose and scene scale; they are **not swept-motion/seat/route envelopes**. Use the recorded positions and model scales when fitting new assets.

| Current actor | Triangles | Meshes | Unique materials | Geometry MiB | Current world size X × Y × Z |
|---|---:|---:|---:|---:|---|
| orchestrator | 35,524 | 21 | 21 | 3.19 | 3.77 × 4.59 × 2.78 |
| codex:orchestrator | 35,080 | 24 | 24 | 3.1 | 3.54 × 4.63 × 2.78 |
| product | 31,400 | 17 | 17 | 2.55 | 1.82 × 2.05 × 1.55 |
| codex:product | 31,004 | 19 | 19 | 2.47 | 1.83 × 2.05 × 1.56 |
| architect | 31,936 | 20 | 20 | 2.62 | 1.95 × 2.15 × 1.56 |
| codex:architect | 31,540 | 22 | 22 | 2.54 | 1.94 × 2.15 × 1.56 |
| developer | 32,012 | 21 | 21 | 2.67 | 1.79 × 2.13 × 1.58 |
| codex:developer | 31,220 | 24 | 24 | 2.52 | 1.78 × 2.13 × 1.57 |
| scout | 33,708 | 24 | 24 | 2.85 | 1.95 × 2.09 × 1.59 |
| codex:scout | 33,312 | 26 | 26 | 2.77 | 1.96 × 2.09 × 1.6 |
| runner | 32,796 | 21 | 21 | 2.65 | 1.91 × 2.05 × 1.41 |
| codex:runner | 32,004 | 24 | 24 | 2.5 | 1.92 × 2.05 × 1.42 |
| qa | 37,436 | 22 | 22 | 3.6 | 1.76 × 2.18 × 1.56 |
| codex:qa | 36,644 | 25 | 25 | 3.44 | 1.74 × 2.19 × 1.55 |
| security | 32,052 | 20 | 20 | 2.64 | 1.87 × 2.11 × 1.54 |
| codex:security | 31,260 | 23 | 23 | 2.49 | 1.86 × 2.11 × 1.54 |
| designer | 34,428 | 21 | 21 | 2.86 | 1.54 × 2.13 × 1.79 |
| codex:designer | 33,636 | 24 | 24 | 2.7 | 1.55 × 2.14 × 1.8 |
| herald | 31,756 | 22 | 22 | 2.56 | 1.56 × 2.1 × 1.89 |
| codex:herald | 30,964 | 24 | 24 | 2.41 | 1.56 × 2.1 × 1.89 |
| debugger | 24,330 | 10 | 9 | 1.4 | 1.74 × 2.05 × 1.45 |
| release-manager | 29,116 | 8 | 8 | 2.08 | 1.97 × 2.04 × 1.81 |
| knowledge-keeper | 31,680 | 16 | 14 | 2.47 | 1.56 × 2.26 × 1.79 |
| docs-writer | 24,198 | 6 | 6 | 1.39 | 1.64 × 2.04 × 1.85 |
| stem-cub | 29,304 | 10 | 8 | 2.05 | 1.31 × 1.76 × 1.03 |

[All ambient roles/poses, per-actor textures and bounds](./actor-costs.json). [Current body/portrait/outfit/tool/socket map](./role-appearance-map.json). No current or retired actor was removed to improve a number.

## Reproduce and compare

1. Finish checkout creation, then npm ci in the isolated worktree. Use the same source commit for an exact rerun. Run node parse-glbs.mjs and node measure-static-garden.mjs from this directory's scripts with the repository as cwd.
2. From the repository root run: timeout 900s node docs/research/team-and-den-ux-22/baseline-server.mjs. It builds into /tmp and serves read-only assets on port 4422. The production source stays unchanged; the transform only exposes world/renderer ownership for observation. Stop it after capture.
3. Run baseline-windows.cjs with an existing Windows Node + Chrome and existing Playwright/Playwright-core available under 22-runtime/node_modules beside the script, as in the capture evidence folder. No new package was added to the repo. The script records its browser version and verifies NVIDIA hardware rendering and exact actor counts before accepting any sample. Use a temporary browser profile, never the user's signed-in profile.
4. Retain output JSON and screenshots, verify all ten scenarios, zero write requests/errors and correct counts, then compare like-for-like. The application RNG was not overridden; this is one short capture per scenario, not a deterministic path proof or stability soak. Fix counts, camera and timing recipe and use repeated longer runs for the asset acceptance verdict.

## Limits and quality controls

The first crowd fixture supplied projectId:null, which the current identity adapter rejects. It rendered only 25 actors. That capture was **discarded**; this report uses the corrected fixture and explicit 25/29/35 count assertions. No invalid crowd samples appear in the summary. Hardware was verified through ANGLE/NVIDIA, not inferred from FPS. Screenshot evidence confirms real scene draws and the existing inset shell. No shader/light/frame-cap simplification was applied.

This does not test the installed den under normal signed-in usage, a full-window canvas, future 03 actors, new mixed-species geometry, cold-load stability, long-session GPU resets or maximum possible future visitor capacity. Other user applications were not stopped; driver clocks/cache/background load can affect short samples, including different GPU timings across cases. Use paired repeated measurements before claiming regression or headroom.

## Artifacts

- [Summary JSON](./baseline-summary.json), [compressed raw render/query/animation samples](./baseline-raw.json.gz), [reference GPU/driver details](./reference-gpu.json).
- [Idle light screenshot](./baseline-idle-light.png), [meeting dark screenshot](./baseline-meeting-dark.png), [first-person screenshot](./baseline-walk-light.png).
- [Costed two-character proposal](./two-character-proof-plan.md), [asset inventory](./asset-inventory.md).
