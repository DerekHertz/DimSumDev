# Bao appearance candidate — ticket 24

**Rejected by the user on 2026-10-20.** The local optimized candidate documented below is historical evidence, not an accepted appearance. New Meshy sources and actual 60-credit spend are recorded in [meshy-revision/README.md](meshy-revision/README.md); selection and final acceptance remain pending. The zero-credit figures below describe only the rejected local experiment.

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
| Desk/conversation/meeting fit | CPU pose/prop envelopes measured; current navigation/seat fixtures in scoped test log; native host anchor/meeting shown. Detailed existing desk/chair geometry fixture work remains |
| Motion and reduced motion | `bao-production.test.mjs` tests walk, sit, idle, shared gestures, static reduced poses and normalized weights |
| Matching 48/72 portrait and identity | Source-rendered `bao-jade.webp`; runtime-specific factory tests; explicit 48/72 authoring scale sheet plus native Team captures |
| States, fallback and rollback | Old body/costume retained; missing-model factory falls back at same 1.35 scale; old portrait retained with one-attempt image fallback; native failed-model/portrait check confirms same camera and scale. Broader live state/action verification remains |
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

## Appearance review captures

`capture-provenance.json` pins all final image hashes, model/portrait hashes and the
instrumented production build at **1044667c78cdb29500e31bc1088da41c2e47df2a**.
The subsequent evidence commit changes documentation, capture-fixture code and the
portrait's executable mode only; the shipped model and portrait bytes are identical.
Native Chrome reported the RTX3060Ti reference device; these screenshots do not
stand in for the pending timed before/after benchmark.

There are 12 real-den theme/view captures: 36 actors for the Working fixture and
42 for the six-seat meeting fixture; each contains one actual Bao. Working has no
meeting; meeting uses valid ref `baseline/24-bao` and title `Bao appearance fitting`.
The close first-person fixture uses the existing explorer start contract at
(-1.75, 6.2), with the measured camera eye at y=2.08. No product camera code changed.
The fixture bridge is read-only and shows the existing Reconnecting state. Captures
reported zero page errors and zero write requests.

The native Team portrait image boxes are currently **40/62px** (the shell was not
resized). `portrait-48-72-authoring.png` is an explicit separate 48/72px scale sheet.
`den-light-fallback.png` forces both new assets to fail and shows the retained old
portrait/body, with scale1.35 and camera target/zoom unchanged when Team opens.

`sit-first.png` is an **authoring seated-pose preview**, not a claim that Bao sits
in a host chair at runtime. Bao remains stationary/standing at its existing anchor;
the current scene does not provide a Bao host chair. Future completion must validate
the conservative envelopes against relevant existing desk/conversation/chair geometry
fixtures without adding a host chair or changing the layout.

Final image directory:
`/mnt/c/Users/Derek/.codex/visualizations/2026/10/19/01a15689-f776-7ab1-8ca6-13d1dbc49206/ticket24/`.
Use near-working, near-meeting, far-working, first-person and portraits PNGs with
the appropriate `den-light-` / `den-dark-` prefix; the hashes are in the provenance.
Focused source checks: **72/72 pass**, concurrency1; `/tmp/24-developer-tests.txt`.
All corrected failed calls and fixture limitations are recorded in `incidents.md`.
