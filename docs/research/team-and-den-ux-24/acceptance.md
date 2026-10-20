# Bao acceptance evidence

This continues the approved selected Meshy-A appearance at `a1b0683`. Appearance, atlas bytes, geometry, portrait and the source rig weights remain unchanged. The only product correction here is Bao's authoring seated pelvis drop `.12 → .0531`: its crown/pelvis rises **0.090315 world units** while the floor/root anchor stays fixed. Final user fitting review must include this visible pose correction. Bao still stands at its runtime host anchor and has no runtime chair or desk.

## Furniture and navigation

`clearance.mjs` measures delivered deformed indexed triangles, including robe/pouch and visible cup. `clearance.json` records every sampled pose and fixture. Host: `[-1.75,.29,-.6]`, scale `1.35`; 150 pose samples across idle/work/walk/sit/wave/tea have zero intersections with conservative current welcome furniture/table solids. The 21 current table seat coordinates across one to six seats clear the **actual 16-sided tabletop and legs**, using triangle clipping against convex solids. These are authoring placement probes; they do not create a runtime host-chair contract.

The existing Product standing workstation clears its desktop, drawers and stool. Sitting at that standing home is an intentionally invalid placement and remains marked as a diagnostic, rather than a chair fit. At the actual padded stool center `[-2.45,.575,-15.76]`, the corrected pose has zero actual rounded-cushion/base crossings. Across 25 breath frames, a **0.000135-world-unit pelvis nudge toward the cushion produces contact**, proving the clear pose is supported rather than floated away. Feet hang naturally above the pavilion floor (lowest vertex `.871882`, floor `.575`); none penetrate it. Pose-cycle envelope and maximum-edge-stretch tests remain unchanged and pass.

A walker at `[-4.6,.26,-.6]` can approach within the current 3.25-unit conversation range by a 20-waypoint route without intersecting Bao's geometry. Two deliberately tested front approaches were blocked by the table's navigation proxy; the west-side approach uses the actual existing free path. The host and all six meeting-seat navigation fixtures remain recorded.

Published conservative envelopes in rig units: standing `r1.9,h3.2`; moving `r1.95,h3.2`; seated `r1.9,h3.1`; head `r1.6,top3.2,labelTop3`. Multiply dimensions by `1.35` for Bao; add each placement's root elevation for absolute heights. They cover garments/props; they are not substituted for the smaller existing first-person walker collision radius.

## State, identity, actions and rollback

`native-acceptance.cjs` runs a real instrumented production UI in native Windows Chrome on RTX3060Ti, 1440×900/DPR1, with persistent local HTTP SSE and fixture HTTP responses. It exercises At home, Working, Needs you; a second Claude Bao, Jiao and a foreign project; Talk; exact visitor `runId` POST; disabled Codex controls; Escape/focus/camera preservation; loading, core-model error, offline controls and asset/portrait fallback. Ten cases passed with zero page errors and two exact `/conversations/orchestrator/message` requests bound to `bao-visitor`. These are actual UI/session/client wire requests to fixtures, not real CLI execution. Existing backend host-conversation (24 tests) and host-message (19 tests) also pass with injected runtime services.

Current approved shell text is At home/Working/Needs you/Blocked/Idle/Throttled and Talk/View work. Resting is an activity count, not a profile label. Not set up and Take over are absent from both current original-appearance and selected-appearance shells; this does not claim those obsolete controls work. The approved 22 plan's “Frame-time and motion acceptance” explicitly calls for Talk/View work; 04 remains the shell/layout contract. No shell redesign or authority change was made.

`bao-acceptance.test.mjs` checks real delivered original/replacement factory paths through the production live adapter, actor controller, roster and cards: distinct tasks have independent figures; same-task runs retain independent bodies/skeletons/cards/action source IDs; foreign project does not bind; Jiao cannot inherit Claude actions; remaining run takes the primary binding; host acquires no chair. Existing 42 tool-binding tests are retained.

Pre-existing limits, **not passed or waived**: same-role/runtime/project/ref runs share a ticket-label anchor (`3` run-keyed figures expected in the diagnostic, `2` actual including Jiao), in both appearances. Also, the existing concurrent-Bao visitor placement has actual body triangle intersections with both original and selected Bao (`pair-clearance.mjs/json`). These require an orchestrator-owned scope/follow-up decision. Exact identities and actions remain independent.

At those identical observed visitor positions, selected posed bounds are contained within the original posed bounds on all three axes. Their conservative overlap-box extent shrinks from `[2.9234,4.5600,1.5829]` to `[2.1175,4.0200,.9259]` (box volume21.1008→7.8817). This does not estimate actual interpenetration volume or certify body clearance; it shows no expansion of that conservative occupied region. Original witness `[-2.82736,2.73794,-.78281]`; selected witness `[-3.28497,1.74917,-.75160]`. Root classified the unchanged placement problem as an orchestrator follow-up outside24.

Old shipped geometry and portrait remain packaged. Native forced model+portrait failure selects legacy species/scale1.35 and original portrait. Baseline and selected states preserve identical resident anchors, camera target/position/zoom and current shell layout. Prior near/far/first-person/light/dark/native captures remain in the approved fitting receipt; new actual-stool captures accompany this continuation.

## Disposal and heap

Five real React root load/unmount cycles **per appearance**, not manual disposal alone: original renderer counts plateau at 1,407 geometries/116 textures, selected at 1,371/117. Selected live GL counts plateau at 5,657 buffers/121 textures/18 programs/2,275 VAOs. Every unmount returns intervals, timeouts, EventSources, live-store subscriptions, canvases and buffers to zero. All contexts report lost; five internal textures/programs and a framebuffer/renderbuffer remain in explicit-delete counters, but belong to lost contexts. Counts distinguish explicit deletion from context release and make no driver-VRAM claim.

GC loaded heap, cycles1→5: original **365.83→368.45 MB**, selected **359.60→362.35 MB**. Disposed: original **347.12→349.08 MB**, selected **344.23→346.24 MB**. Both exhibit similar tapering engine/page warm-up; replacement loaded heap stays about6MB lower. This is not a claim of a perfectly flat heap or exact process RAM. CPU factory tests separately verify every owned rig geometry/material/bone texture disposes once, while externally owned source assets stay cached.

## Matched performance recipe and baseline provenance

`native-performance.cjs` prepares the approved ten scenarios × three repeats ×10s warm-up +30s samples ×before/after, one native Chrome, alternating pair order to expose drift. It records raw draw/CPU/animation/GPU timer samples, disjoint counts, actors/visitors/meeting guests, settings, memory, scene/garden resources, and NVIDIA graphics/memory clocks/P-state/power/temperature every5s. Disjoint or insufficient/incorrect hardware samples fail; no synthetic draws or FPS-cap-only acceptance.

Before uses this same current build with **only `assets['characters.bao']` removed from the manifest before world load** and the original portrait served. It never requests/loads the selected GLB, never enters failed-load fallback and does not use rejected local art. The original body `bao.glb.gz` has unchanged SHA256 `793118be3b0c3fa311a9baf21081e7482c713abf60a564333726527b06cc616c`; vest/headphones/scarf and legacy role outfit/tool branches are unchanged from current `origin/main`. Shared rig edits are Bao-profile opt-ins or preserve legacy defaults; new source profile is unused in before. Both run the same 04 shell, actor/navigation/camera/garden runtime. Parent approved atlas exception remains exactly1,398,100 **GL-requested** bytes, not driver VRAM.

Full 60-run hardware comparison, pooled/per-scenario p95 verdict, independent QA/code review and final user fitting/performance acceptance remain pending at this checkpoint. Prepared harness is not performance evidence.

## Verification map

| Criterion | Test/evidence | Status |
| --- | --- | --- |
| Approved source/method/spend | Existing Bao production/provenance tests, ledger65/100credits, no new stages | Preserved |
| Desk/conversation/meeting fitting | New actual-stool contact test, `clearance.json`, current nav/home/meeting/route tests, native stool capture | CPU green; user fitting verdict pending |
| Five motions/reduced motion/envelopes | Existing Bao production cycle/wave/static-rest tests and `measure-bao.mjs` | Green; seated capture updated |
| Model/portrait/runtime/project/run binding | Actual-asset integration test + native before/after UI wire cases; existing 42 tests | Green for current supported contracts; pre-existing anchor/body limits explicit |
| State/action/fallback/rollback | Native ten cases, camera/anchor equality, retained fallback assets,43backend tests | Green for current shell; obsolete names not applicable to both |
| Budgets/garden/frame-time | Existing per-character/garden tests, matched disposal; prepared full hardware recipe | Resource evidence green; full GPU comparison pending |
| User final verdict | Approved model/portrait/atlas checkpoint; new seated fit + full performance | Pending, not self-approved |

Failed calls and red diagnostic history: `acceptance-incidents.md`. Nonhidden focused output: `/tmp/24-final-focused-tests.txt`.
