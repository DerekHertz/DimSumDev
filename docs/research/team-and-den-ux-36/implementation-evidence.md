# PR383: stable owned homes first

## Scope and preserved work

The user approved narrowing [PR383](https://github.com/DerekHertz/DimSumDev/pull/383) to homes first, deferring tea trips and visitors. The scene keeps its32 resident models at stable, individually owned homes. Live work still comes from the bridge snapshot; additional runs and meeting participants remain accessible in Team with exact work/tool identity. They receive no borrowed resident body, scene anchor or claimed meeting seat. Meetings and table controls remain available.

Tea outings, moving meeting participants, physical visitor copies, outgoing/return certificates and admission retries are outside this deliverable. Their implementation and full travel tests remain preserved in commit `67f79eed2c25f25e4470ed328541d4d79db43a82` and preceding PR history. They are removed from the active caller, rather than hidden behind a configuration flag or replaced with a scheduler. No cross-frame admission, worker, dependency, safety permission or resource-limit change is included.

Main was synced after the user merged Codex instructions [PR386](https://github.com/DerekHertz/DimSumDev/pull/386), merge `be03220f9d3da7ab222f1a9e6b40bd96cdc31c44`. Those instructions are inherited from main, not a second product-branch instruction change. Terrain extraction [PR384](https://github.com/DerekHertz/DimSumDev/pull/384) was already merged.

## Implementation contract

- A small homes adapter uses the existing single registry, conservative measured rig/prop envelope, actual terrain support/height, body and owned-place clearance, and the authored player-entry footprint.
- One bounded allocation allowance spans primary home and staging search. Failure hides the unplaceable body with `Scene place unavailable`; a fitting staging home says `Workspace unavailable — at a safe home`. Full fit and ownership are never waived to obtain a visible model.
- Homes are allocated once. Live rebinding updates the full owner identity without terrain searches, model creation, relocation or lease-coordinate changes. Updates animate idle poses only. Reduced motion cannot teleport a resident.
- Extra logical runs say `Scene visitor deferred — available in Team`. Team preserves Working/ref, View work, run-specific tool inspection, keyboard focus, transcript source and redaction. No extra bodies or invented seat labels are published.
- Bao's validated authored lifted home remains exact where it fits. Other authored positions may require a fitting alternate home; an authored overlap is not preserved by weakening clearance.

## Native responsiveness evidence

The first homes-first working candidate was measured in native Chrome155.0.8059.85 on2026-10-21. Test-only events observe the actual `createMeshyActors` constructor and retain calls to the original production methods; no algorithm or bounds shortcut replaces them. The source is bound by SHA256 hashes for `actors`, `actor-homes`, `actor-envelope`, `places`, `allocation-work` and `navigation` in the saved `native-homes-method.json` and `native-homes-readiness.json` receipts. Subsequent changes to tests/docs do not change those measured production bytes.

- Actual32-model construction: **1321.5ms**; all32 visible and individually owned. Full measured footprints and pairwise clearance passed; every home clears the actual walker entry.
-100 changing logical binding sets plus meeting observations: median0.1ms, p95 0.2ms, maximum0.7ms. No extra body was created; the actual model/home positions remain identical.
-800 original stationary production updates: median0.9ms, p95 1.5ms, maximum2.2ms. Binding and updates made **zero terrain queries**.
- Eight seconds of native drawing:465 sampled frame intervals, median16.7ms, p95 16.8ms, maximum50ms.235 actor-update samples had maximum3.9ms; render-submission maximum29.7ms. Den/Panda zoom controls worked after the sample.
- Zero page errors or write requests. The owned browser closed; the temporary loopback server was explicitly closed and cleanup receipts retained.

These are single uncontrolled local samples, not invented acceptance thresholds, a regression percentage, a GPU/VRAM/leak claim or acceptance of deferred travel. Construction still has a measurable1.32-second synchronous cost during scene loading; it is reported rather than hidden behind settled-frame statistics. There is no repeated admission or trip-proof work after readiness. Final visual acceptance remains with the user.

The previous full-scope exact67f79eed sample (18:37:06.768–18:38:53.612 UTC) measured4891.2ms construction,38345.3ms crowd admission and17838.5ms maximum update. Those paths are deferred in this slice. Earlier12cc7be measurements29963.3/9118.4ms are historical, not current-head acceptance. Their original evidence remains in git history and local source-bound receipts.

## Validation contract

Covering checks retain exact envelope differentials, actual curved-stream/pillar/full-footprint checks, home/staging ownership, bounded failure, entry escape, stable32 ownership across live/reduced/meeting observations, runtime selection, exact Bao lift, asset disposal, truthful Team state and reachability. The original Cub browser walking test is unchanged. Resident tool source/focus/redaction/lifecycle checks remain; the deferred guest's exact-source keyboard inspection now uses Team.

Deferred travel/visitor integration assertions were explicitly retired with the approved scope, not skipped or given looser tolerances. Registry/terrain/envelope assertions remain. Test-guard findings require independent QA disposition; a nonzero guard exit is not claimed as clean. Hosted CI supplies required full/rest/browser/security verification at the eventual pushed head; local checks and independent review are recorded in the PR body.

## Why earlier review churn happened

Useful reviews found genuine crossing-progress, overlap/foreign ownership, full-footprint/water/overhead, retry, stairs/batched-solid compatibility, Bao-height and player-entry defects. Avoidable cycles included an incorrect AABB-corner oracle, expecting every leisure actor to settle, frozen identity assumptions despite valid rebinding, fixture/lease mismatches and repeated per-attempt handoffs. Real-roster wall-clock costs were measured after the original broad homes/trip/admission proof scope was implemented. No exact wasted-hours figure is supported.

The bounded Codex correction was delivered separately in386: configured runtime models, one implementation owner, optional bounded independent work, literal covering checks, early actual-caller timings, explicit blockers versus polish and convergent review. Shared safety and human publication/merge gates remain. This PR applies that approach to the approved smaller product outcome.
