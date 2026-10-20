# Bao Meshy source choice — 2026-10-20

The user rejected the local vertex-color candidate at `208f996` (“why does it look worse,use meshy please”). These two new sources are a visual choice checkpoint, with no selected replacement yet. The original shipped Bao remains the fallback. No scene asset, portrait, rig, manifest or runtime behavior changed in this revision.

The approved design is Bao in the header of ticket 15's `15-cast-r3.png`, not the rejected local portrait. No standalone approved Bao reference existed in the existing Meshy refs or design-worktree image inventory. Built-in imagegen isolated Bao from that sheet as `bao-reference.png`: broad giant-panda head/body, warm friendly face, jade crossed wrap, cream belly, brown belt/pouch, raised greeting paw; no other characters or text. This preparation preserves the chosen design, and is not a Meshy 2D task or paid Meshy stage. See `ledger.json` for input hashes and exact 3D texture guidance.

| Source | A: A-pose | B: reference pose |
|---|---|---|
| Task (image-to-3d) | 01a15a76-e214-75bf-a510-25c77230a8a2 | 01a15a78-f44b-73e4-a5cd-5a73b59c1eb2 |
| Provider status | SUCCEEDED | SUCCEEDED |
| Actual consumed credits | 30 | 30 |
| Raw triangles (loaded GLB) | 505,330 | 622,914 |
| GLB bytes | 17,358,972 | 20,518,712 |
| Raw primitives / materials / color image | 1 / 1 / 2048×2048 | 1 / 1 / 2048×2048 |
| Difference | Arms separated for later local rigging | Raised-paw pose closely follows reference |

Both use standard Meshy 7, explicit `ai_model: meshy-7`, texture on, 2K, PBR off, Ultra off, image enhancement off, remove lighting on. Only pose-mode differs: `a-pose` vs `auto`. The supported CLI 0.4.0 planner quoted 30 credits per textured image source; balance was 433 before, 373 afterward. **Actual total: 60 of the approved 100 existing credits; 40 remain; $0 purchases.** No remesh, rig, animation, conversion or third generation was submitted.

## Review evidence

Provider thumbnails are committed alongside this note and were inspected, as were local front, side and distant renders. Native Chrome loaded the actual GLBs in the same neutral Three scene at 1024×768. Both front faces remain friendly and the jade clothing reads at a distance. A exposes both paws and has a more upright, separated-limb silhouette; B keeps the reference's broad belly and greeting. The side views reveal incised fur-like marks and small surface artifacts that are less obvious in the provider thumbnail. B's lowered arm lies close to its side, so pose normalization/rig suitability remains to be established after selection. Neither source is accepted or topology-validated by its thumbnail.

Rendered review files are under:
`/mnt/c/Users/Derek/.codex/visualizations/2026/10/19/01a15689-f776-7ab1-8ca6-13d1dbc49206/ticket24-meshy`
- `candidate-{a,b}-provider.png`: actual Meshy rendered thumbnails.
- `candidate-{a,b}-{front,side,quarter,distant}.png`: local renders of each downloaded GLB.
- `local-inspection-{a,b}.json`: measured source counts, raw bounds, image sizes and zero page errors.
- `bao-reference.png`: prepared input.

These are authoring source renders, not in-den fitting, portrait, animation or performance evidence. Distant view uses an orthographic half-height of 8 with the model normalized to height 3, about 144px tall. No camera/layout or model adoption claim follows from these images.

## Preserved sources and next step

Raw files and full CLI project/task snapshots are retained untracked in this worktree at:
`/home/dhertzell/dimsumden/.worktrees/bao-24/meshy_output/24-candidates/`
The GLBs are `candidate-a.glb` and `candidate-b.glb`; each project under `projects/` retains its owning task and resource. Full local task snapshots contain provider download URLs; only selected metadata and hashes are committed here. Recover expired downloads through the existing image-to-3d IDs, never by regeneration.

**Next: user chooses A, B, or neither from the previews.** Stop before remesh, cleanup, rigging, fitting or adoption. After selection, the complete actor still needs ≤12k triangles, ≤6 draws, ≤32 bones, one 512px atlas plus aggregate performance, memory, fitting, states, matching 48/72 portraits and final user verdict. The 2K raw source is not a proposed runtime texture allowance; a later texture-memory tradeoff must be measured and agreed.

## Validation and incidents

Both GLBs loaded in native Chrome, with zero page errors, measured triangles and one 2048² color texture each. SHA-256 hashes cover inputs, raw GLBs, provider thumbnails and local renders in `ledger.json`. A read-only runner independently verified those hashes and byte counts, the credit arithmetic, GLB v2 headers, exact triangle counts, primitive/material/base-color texture counts and source-choice scope. These are research artifacts only; no new application tests or full suite were run. The prior 72-test result belongs to the rejected candidate, not these sources.

Failed calls:
- Unprivileged `npm exec … image-to-3d create --help`: `EROFS: read-only file system, open '/home/dhertzell/.npm/_cacache/tmp/f4a4c166'`; existing-cache help succeeded with escalation. Sandbox/cache friction; no paid call failed.
- `rg … scripts/production*`: `No such file or directory (os error 2)`; corrected by exact file inventory. Filename assumption.
- Broad `rg --files /tmp`: exit2 with truncated inventory; exact root-level file inventory used instead. Scope/search friction; no source modified.
- Native capture at conventional Node path: `timeout: failed to run command ‘/mnt/c/Program Files/nodejs/node.exe’: No such file or directory`; `where.exe node` resolved existing `D:\\NodeJS\\node.exe` and both captures succeeded. Path assumption.
CLI download warnings `files_outside_project` were expected: selected output files were deliberately placed at the workspace root and explicitly recorded in this ledger.

- Runner validation initially read beyond the declared GLB JSON chunk: `SyntaxError: Unexpected non-whitespace character after JSON at position 1800 (line 1 column 1801)`; corrected the read boundary and all checks passed. Validation helper error, no asset mismatch.
