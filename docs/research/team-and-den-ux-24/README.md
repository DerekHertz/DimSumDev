# Bao appearance candidate — ticket 24

Candidate only: user appearance verdict, independent review and matched reference-box
performance acceptance remain open. No installed den, service or router change.

The approved source is the Bao tile of `15-cast-r3.png` (broad giant-panda head/body,
jade sash), with the signed spec on the main board at `handoffs/15-designer-spec-final.md`.
This candidate reuses the shipped Balanced Bao, preserves its 2,549 front-face
triangles and simplifies the remaining body offline. Its smooth source normals and
UV colours are retained as baked vertex colours; jade wrap/pouch are flat geometry.
No Meshy submission, credit charge, balance-consuming task, purchase or new dependency.
Actual spend: **0 credits / $0** of the approved 100-existing-credit maximum.

## Reproduction and package

`node apps/ui/assets-src/den/build-bao.mjs` recreates the compressed model,
manifest entry and `bao-provenance.json` from the retained source body. Pillow is
an existing offline tool; Three's existing SimplifyModifier never runs per actor.
The base package's full rebuild must be followed by this derived-asset command.
`bao-review.html` is an offline authoring preview, separate from the product UI.

| Complete Bao cost | Candidate |
|---|---:|
| Base triangles, including sash and pouch | 7,890 |
| With optional shared leisure cup | 7,970 |
| Main-pass draws / with cup | 2 / 4 |
| Shadow-eligible triangles | 7,890 |
| Skinned geometry attribute/index bytes | 550,140 |
| Bones / weights per vertex | 26 / 4 |
| Unique texture images / added texture memory | 0 / 0 |

`fitting.json` records CPU measurements on the packaged mesh, including a 0.2s sweep
through idle, walk, sit, tea, greeting/wave, pond and working/mahjong gestures. These
are geometry measurements, not GPU/frame-rate evidence. Envelopes in `bao-profile.mjs`
are in rig units, multiplied by the unchanged executive scale 1.35. They include
the jade wrap, pouch and raised cup. The original bubble crown anchor stays at 3;
the conservative swept head ceiling is separately 3.2. Seated lowest point is
−0.0046 rig units (the existing floor tolerance is −0.02).

The current inventory is **32 resident identities**, including Bao (Claude
orchestrator) and Jiao (Codex orchestrator), plus separately populated ambient pandas
and run-specific visitors/meeting guests. Every Claude orchestrator instance selects
Bao; Jiao and other identities keep their own sources/costumes. Labels, projects,
runs, Take over, tool inspection, action keys, camera and shell dimensions retain
their existing ownership and bindings.

## Acceptance evidence and remaining work

| Criterion | Evidence / status |
|---|---|
| Approved source/method/cost | Signed 15 source, approved 24 budget; local reuse, zero paid tasks; provenance JSON |
| Desk/conversation/meeting fit | CPU pose/prop envelopes measured; current navigation/seat fixtures in scoped test log; native captures pending |
| Motion and reduced motion | `bao-production.test.mjs` tests walk, sit, idle, shared gestures, static reduced poses and normalized weights |
| Matching 48/72 portrait and identity | Source-rendered `bao-jade.webp`; runtime-specific factory tests; native scale capture pending |
| States, fallback and rollback | Old body/costume retained; missing-model factory falls back at same 1.35 scale; old portrait retained with one-attempt image fallback; native checks pending |
| Character/aggregate budgets, themes/views | Per-character CPU costs above; garden guards retained. Full-scene matched GPU, frame, heap and aggregate comparisons pending |
| User visual/performance verdict | **Pending — candidate is not accepted** |

Real-den observation builds use `capture-server.mjs`, adapted from the ticket 23
harness without changing shipped source. Full acceptance requires the unchanged
reference recipe: Windows Chrome / RTX 3060 Ti, 1440×900, DPR1, same camera/counts,
30fps cap, themes, walk/meeting/reduced-motion scenarios, three repetitions,
10s warmup + 30s sample per case, sequential before then after (~40min quiet GPU).
Do not use the previous proof's +2.67MiB texture exception for Bao. Texture cost
is flat here; aggregate geometry and steady heap still need matched measurements.

Rollback: omit `characters.bao` from the loaded character map (or remove that manifest
entry), and point the Claude orchestrator portrait to `ROLE_PORTRAIT_FALLBACKS`.
The retained body, costume and portrait require no camera/layout change. Source model
or portrait load errors preserve fixed portrait dimensions, role text and controls.
