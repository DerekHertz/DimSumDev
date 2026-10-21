# Ticket 36: owned places and safe tea routes

## Readiness follow-up — 2026-10-21

This follow-up starts from draft PR [#383](https://github.com/DerekHertz/DimSumDev/pull/383) at `f69a9e205e176b34c6b740e41fc6d2bdc0915a74`, with preserved product source `12cc7bee8227a3b5fc198bfe8a8ab469f23fed0b`. The earlier decision extracted terrain clearance separately and retained #383 as a reference. The user subsequently authorized pushing the bounded performance fixes to #383 and continuing its readiness work, while publishing Codex rule corrections separately in draft [#386](https://github.com/DerekHertz/DimSumDev/pull/386). No merge is authorized. Terrain-only PR [#384](https://github.com/DerekHertz/DimSumDev/pull/384) merged as `d53ffe7ae160f3f88ff0aec02b2024fdc3b3c630`, with final CI passing at `ea0b3352417a59b9151905df72134c1df5b519d8`; it does not accept #383's crowd subsystem.

The remaining outcomes are 51 (stable resident homes), 52 (one owned tea round trip), then 53 (responsive visitor admission). They are planning only, awaiting owner-approved timing/design decisions before implementation. The proposed 500 ms construction/admission and 50 ms maximum-update targets are not approved requirements. Preserve the ownership, clearance, retry and lifecycle contracts; defer broader admission and ambient expansion through those explicit scopes.

The preserved-source measurements below remain historical evidence, not acceptance of the follow-up. Remaining synchronous stalls still block readiness; no assertion or timing threshold is waived to make the PR green.

## Local responsiveness review candidate

The authorized follow-up prepares two optimizations on an isolated clone of `f69a9e2`. In `navigation.mjs`, cached footprint rectangles record their highest solid and whether they contain excluded terrain. A candidate ground bypasses cell iteration only if the entire conservative rectangle has no excluded terrain and every solid is at or below `ground + .12`; all other queries keep the original exact checks. In `actor-envelope.mjs`, precise posed bounds reuse each bone transform product within one mesh/pose, retaining double precision, morph processing, vertex order, props, sampled poses and final remeasurement. Custom skinned behavior and instanced geometry retain Three's original bounds path. Query keys, cache capacities, search order, body dimensions and work limits are unchanged. These changes contain none of #386's instruction edits.

Sequential CPU-profiled Node 18.19.1 samples on the actual 32-resident roster measured construction **9,316.4 ms** at baseline, **7,323.5 ms** with terrain alone, then **5,448.1 ms** with both changes. Every version performed **153,174** terrain queries and produced exactly matching home positions, identities and envelopes. Actual posed-vertex bounds, independent garden clearance, visibility, ownership and pairwise separation passed for all 32. Exact source hashes, source/base and methods are retained in the local benchmark manifest; these are instrumented single samples, not an acceptance threshold.

Native Chrome 155.0.8059.85 separately initialized the unchanged `f69a9e2` baseline and final uncommitted candidate on 2026-10-21, 17:00:32–17:00:57 UTC. Constructor timing was **5,158.3 → 4,344.6 ms**; page-ready time was **11,443 → 11,583 ms**. All 32 home/identity/envelope outcomes matched exactly, with zero page errors or write requests. Only initialization ran; no crowd, tea trip or settled sample was repeated. The owned browser closed; separate checks found the owned server process absent and both loopback ports refusing connections. These sequential samples show partial constructor improvement, no page-ready improvement and no overall responsiveness acceptance.

Fresh focused verification covers **72 distinct tests** across ten literal files: a 71/71 covering run in 26,574.6 ms, followed by 4/4 final envelope/fallback tests in 300.6 ms (three overlap the covering run). Zero failures/skips/cancellations. The new envelope tests compare Three's original precise path for weighted skinning, absolute/relative morphs, transformed props, live edits, custom vertices and instanced props. A deterministic mixed-geometry comparison checked 12,000 terrain queries against the preserved implementation, with zero mismatches. Syntax passed. No full suite, native crowd or CI rerun was performed; independent review, full responsiveness acceptance and publication remain outstanding. The remaining 4.34-second constructor is still a substantial stall.

## Preserved product source

**Preserved product candidate:** `12cc7bee8227a3b5fc198bfe8a8ab469f23fed0b`, draft PR #383. The developer reports frozen **138/138** focused checks across 17 literal files, four syntax checks and the production UI build passing in private board handoff `36-developer-15.md`. The root's mounted unavailable-profile check passes **1/1** in 14.403 seconds. Both runs have zero skips/cancellations and receipts showing their owned process groups gone. These are attributed results, not a full-suite result; this writer inspected source, diffs, handoffs and saved receipts, and ran no tests or browser checks.

**Release blocker:** independent code review passes the correction diff, but QA bounces overall AC7 readiness for synchronous responsiveness. The exact-candidate native capture records **29,963.3 ms** crowd admission and a **9,118.4 ms** single production update, versus **343 ms** and **4 ms** on the reference. Low settled update samples do not resolve those stalls. A proposed additional performance pass and numerical targets remain unapproved.

The latest correction preserves Bao and Jiao's existing authored stationary home lift only when the supporting floor and complete raised body fit. Home, model and lease coordinates agree; departure and normal/reduced-motion return validate raised clearance before exact arrival. The original Bao `0.29` assertion and fixtures remain unchanged. Earlier shared-navigation findings are closed by independent review and QA; the retained assertion audit and test-guard dispositions are recorded in `36-code-reviewer-3.md` and `36-qa-verify-3.md` on the private board.

Hosted CI is not established green for this source. The PR-head association lag resolved: [run 39624964707](https://github.com/DerekHertz/DimSumDev/actions/runs/39624964707) belongs to final docs head `f69a9e2`. Its non-browser test and automated security jobs passed; its browser job and overall run were cancelled. Cancellation is not browser acceptance. The explicit `20a854a...HEAD` risk check reports the mounted fixture's network/server hit; formal security review remains deferred until QA passes. Automated security success does not substitute for that independent review. No CI rerun is needed merely to refresh this record.

## Current candidate native evidence

The root captured exact source `12cc7bee` against `20a854a81017637a6f074bb62782643fb6462454` on 2026-10-21, from 15:13:27.565 to 15:15:39.052 UTC. Both use the same Bao assets, actual model textures, native Chrome 155, 1440×900, DPR 1 and no reduced motion. The private receipt and helper identify both sources and original production calls; raw captures and host paths stay private.

All 32 initial residents and all 42 crowd bodies were visible with matching owned homes. The crowd completed 800 accelerated updates with minimum horizontal envelope clearance **0.09185291** scene units. This checks safe placement, not completion of every crowd journey. QA reached owned `leisure:tea` after **570** simulated 0.1-second updates and returned to its exact retained home after another **677**; minimum trip clearance was **0.078482085** scene units.

| Production timing, ms | Reference | Candidate |
|---|---:|---:|
| Initial constructor/allocation | 2.5 | 5,520.3 |
| Synchronous crowd admission | 343 | 29,963.3 |
| Maximum single original production update during crowd fixture | 4 | 9,118.4 |
| Later settled 42-body update p95 | 3.1 | 3.7 |

The enclosing 800-update crowd phase took **26,020.9 ms**, including harness inspection and frame yielding. The single-update maximum times only the original production call. Later rendering samples were sequential and uncontrolled; they establish no five-percent budget verdict, GPU duration, physical VRAM use or memory leak conclusion. Animation-frame heartbeat counts are separate from rendered cadence.

Six screenshots cover light/dark tea arrival, light crowd overview, dark narrow crowd, an unavailable ordinary visitor and an unavailable meeting guest. Hidden unavailable bodies retain accessible Team profiles with truthful `Working` state, their own work references and enabled `View work` actions. At 375×812, document width and scroll width both remain 375px. The receipt records zero page errors and zero write requests. The owned browser closed; both owned servers closed, with their ports refusing connections. The user visual verdict remains pending.

**Historical evidence:** the next section retains the superseded `1bac181` capture. Later sections explicitly marked historical describe product source `d5b7128`, retained in `6bf4ada`; independent review bounced that earlier candidate for unsafe dynamic allocation and incomplete body/terrain clearance. Neither historical capture verifies `12cc7bee` or provides its visual/performance sign-off. The installed-build reproduction record remains on the private board in `36-developer-2.md`; it describes an older pre-04 installed build and is not the comparison baseline.

## Historical native evidence at `1bac181`

The root captured the actual app in native Chrome 155.0.8059.85 on 2026-10-21, from 14:52:05.517 to 14:54:13.159 UTC. Product source was `1bac181`; the comparison baseline was `20a854a81017637a6f074bb62782643fb6462454`. Both contain the same current Bao assets. The saved private receipt, preparation record and helper identify those sources. Raw captures and host paths stay private.

Both builds used actual model textures, 1440×900, DPR 1 and no reduced motion. The canvas measured 1384×856. The helper intercepted actor/camera modules for test-only events, held periodic snapshot rebinding during manual fixtures and called the original controller. It introduced no production debug interface. The final receipt records zero page errors and zero write requests, an owned browser closed, and both loopback servers closed.

All 32 initial candidate residents were visible with matching owned homes. After adding four visitors and six meeting guests, all 42 bodies were visible with matching owned homes. The 800-update crowd check recorded minimum horizontal envelope clearance **0.09185291** scene units. Per-actor identity, home owner, presentation, position, envelope and travel state were saved. Some actors remained safely staged or reported unavailable destinations; this does not establish completion of every crowd journey.

The actual QA reached owned `leisure:tea` after **570** simulated 0.1-second updates and returned to its retained home after another **677**. Minimum horizontal envelope clearance across that trip was **0.078482085** scene units. These were accelerated manual updates in the rendered app, not ordinary wall-clock travel.

Six real screenshots cover tea arrival in light/dark, the crowd overview in light, the crowd at narrow width in dark, an unavailable visitor profile in light, and an unavailable meeting profile at narrow width in dark. The unavailable fixture made navigation inaccessible and checked that ordinary and meeting bodies were hidden with no home/travel and truthful notes. Their native Team profiles still showed `Working`; the visitor's `View work` action was enabled. At 375×812, document width and scroll width were both 375px. The user has not given a visual verdict.

### Responsiveness and harness completion

Crowd admission blocked synchronously for **28,356.4 ms**: `applyLive` took **6,632.1 ms** and `applyMeeting` took **21,724.2 ms**. The following 800 updates took **23,271.2 ms**, with a maximum single production update of **8,038.2 ms**. Initial candidate allocation separately took **5,692.3 ms**. These stalls remain a release blocker even though later samples have low update p95 values.

The first full native attempt failed its 35-second aggregate crowd deadline. Saved fixture work took about 53 seconds, so the private harness raised that step to 90 seconds inside the unchanged 240-second whole-capture deadline. All 800 updates, safety assertions and product work ceilings remained. The second attempt completed with phase timings. That change fixed harness completion; it did not fix the measured product stalls.

### Historical `1bac181` rendering and memory comparison

One nominal eight-second sample ran sequentially for baseline 32, baseline 42, candidate 32 and candidate 42. Counts, camera target `[0,2,-8]`, zoom 1, viewport, assets and settings matched. These later samples omit the synchronous admission and accelerated-update stalls above.

| Measurement | Baseline 32 | Candidate 32 | Baseline 42 | Candidate 42 |
|---|---:|---:|---:|---:|
| Controller update p50 / p95, ms | 1.4 / 2.0 | 1.4 / 1.9 | 1.9 / 3.1 | 2.2 / 3.6 |
| CPU render submission p50 / p95, ms | 15.8 / 18.3 | 16.2 / 18.8 | 18.7 / 23.4 | 19.3 / 27.3 |
| Actual controller/render calls | 229 | 229 | 229 | 221 |
| Animation-frame heartbeat count / p95, ms | 456 / 17.6 | 458 / 17.6 | 456 / 17.6 | 441 / 18.1 |
| CDP used JavaScript heap, MiB | 87.80 | 175.25 | 94.60 | 284.69 |
| Renderer geometries / textures | 1,374 / 116 | 1,374 / 116 | 1,501 / 126 | 1,503 / 126 |
| Draw calls per reported frame | 1,386 | 1,386 | 1,513 | 1,513 |
| Triangles per reported frame | 3,113,490 | 3,113,490 | 3,371,400 | 3,371,400 |

The animation-frame heartbeat is a separate callback, not rendered-frame cadence. CPU submission timings surround `renderer.render` and do not measure GPU duration. Heap uses `Runtime.getHeapUsage` without forced garbage collection. Workload was uncontrolled, samples were unrepeated, and candidate crowd sampling followed its tea trip while baseline sampling did not. Different allocation/travel histories limit attribution. The larger heap and two extra crowd geometries need assessment; these samples establish neither a leak nor physical VRAM use. No performance sign-off follows from this table.

## Implemented behavior

The scene has one place registry for work, meeting, leisure, visitor and staging places. Leases follow the complete project/runtime/role/agent/ticket identity, including a resident's takeover identity. Work homes stay reserved during trips. Departing occupied temporary places stay owned until the body clears them; visitor removal and scene disposal release all of that actor's leases.

The common traveller validates the actual rig, outfit, carried props, leisure gestures and published replacement envelopes. It checks the swept path, terrain and overhead clearance, including final approaches and reduced-motion placement. Allocations use distinct fitting overflow or safe staging rather than a shared fallback. Staging or route failure appears separately from real agent state; presentation availability does not gate execution admission.

Primary stationary homes may retain their valid authored lift above the supporting floor. Raised top clearance, departure and terminal landing are checked conservatively; normal and reduced-motion arrivals publish the exact owned home coordinates. Overflow and moving candidates retain support normalization.

Each allocated home has a protected local departure and reverse path beyond its occupied clearance. Before admitting a trip, the adapter proves outgoing and return routes against a snapshot of bodies, leases, obstacles and navigation. Active trip protection remains until a physically validated arrival at the owned home. This does not reserve a permanent full route from every idle home to the garden.

Yielding retains a stable full-identity winner until remaining swept routes separate or that winner finishes, cancels or disappears. Initial destination rejection, active-route revalidation and failed returns share a three-attempt policy: the first attempt, then two retries on eight-second simulation beats. Repeated identical requests keep their original count and retry time. After exhaustion, unoccupied destinations are released and retries wait for a dependency change, such as ownership, envelope, lease or navigation changes. Body motion alone does not restart the failure budget. Failed replacement requests preserve the previously committed trip, home and occupied leases.

A leisure intent becomes a public outing only after owned travel is admitted. The routine scheduler retains failed-target state across routine-slot cleanup; the existing departure timing and three-outing cap remain. Idle actors without travel or a pending failure skip dependency snapshots.

Scene availability is separate from agent state. The resident profile carries placement and route notes, including notes for meeting guests. A body without a safe owned place is hidden and has no scene label or proximity target; its desk entry and run remain available. Visible bodies can report `Yielding on the path` or `Waiting for a safe route` without claiming arrival.

## Historical shipped-model assembled trip

Trip regression command (a current run does not reproduce the saved candidate measurements):

`timeout 300 node --test --test-concurrency=2 apps/ui/src/scene/meshy/owned-trip.test.mjs`

The test reads the exact vertex data of the six retained shipped GLBs: Bao, developer vest, QA scarf, developer headphones, red-panda developer and cloud-dragon technical writer. It applies the production wardrobe fitting, appearance factory, rigging, role props, leisure gestures, resident homes, scene controller, routine scheduler and assembled garden navigation. Texture decoding is omitted because this Node test measures geometry and ownership, not rendering.

| Item | Observed |
|---|---|
| Permanent actors | 32, all visible |
| Travelling resident | Claude QA |
| Measured conservative envelope | radius 1.23, height 2.28 scene units |
| QA booth home | `[16.33, 0.57, -9.1]` |
| Completed trip | booth → reserved tea place → same reserved home |
| Moving updates | 1,034 |
| Travelled horizontal distance | 69.8255444515 scene units |
| Minimum clearance from another resident | 0.0910246865 scene units |

Every moving update checks its swept segment against the assembled map, keeps its ordinary movement at or below 0.078 scene units per 0.1-second update, and checks the home lease. A visit requires physical arrival within 0.02 units of an occupied destination owned by that actor. Clearance is horizontal center distance minus both measured envelope radii, checked against every other visible resident.

## Historical assembled crowd

The same production fixture then adds four concurrent visitors and six busy-role meeting guests: 42 actors total. It checks 800 updates (80 simulated seconds), pairwise horizontal body separation at every update, truthful owned arrival states, and complete visitor-lease removal when those runs end. The minimum observed clearance was **0.0374187954** scene units. At the end, three meeting guests were still moving; this evidence does not claim every crowd journey completed within that interval.

## Historical covering checks

Independent runner smoke passed **54/54** tests across `actors`, `owned-places`, `owned-trip`, `owned-places-geometry`, `daily-routines`, `garden-route`, `navigation`, and `proximity-card`, with concurrency 2. Ten changed JavaScript modules passed `node --check`. The production UI build passed; its existing large-chunk warning remains.

The retained crossing regression still uses 200 × 0.1-second updates, separation ≥0.8−0.001, actual yielding and both arrivals, in both input orders. Additional cases cover winner cancellation/disposal, a blocked narrow corridor stopping after three attempts, home retention on failure, relevant-only retry reopening, paired runtime/project identities, unavailable routes, held cards, meeting/tool identity, and exact travel speed/gait. Representative tail, shell and antler envelopes remain covered by the geometry tests.

The legacy unreachable reduced-motion meeting test now requires the actor to stay safely put and report unavailability. Its retry coverage now checks exactly three attempts plus stable query counts after exhaustion, rather than assuming a fixed number of internal allocation queries. The held tea visitor test now uses the actual actor ID so it holds the correct runtime's body.

## Historical native rendered scene and trip

One bounded native Chrome 155.0.8059.85 capture completed on 2026-10-21 from 00:35:20.753 to 00:36:32.440 UTC. It served the unmodified candidate `d5b712811a1efc46f9f99eea50213ded66e065d0` and reference `3d1aa13` from separate worktrees. Both used the actual current-04 app, all model textures, a 1440×900 viewport, DPR 1, light theme for measurements, no reduced motion and synthetic read-only snapshots. The canvas was 1384×856 within the 44px top bar and 56px rail. Both species replacements loaded successfully. There were no browser page errors or write requests.

The capture harness intercepted only the served actor and camera modules to emit test-only DOM events. Controller and camera references stayed in the init-script closure. It suppressed periodic snapshot rebinding during manual fixtures, but called the original controller and rendered the real scene. There are no production debug globals, source hooks, renderer stubs or installed-service changes. File-based helpers and raw captures stay private, with their exact paths recorded in the developer handoff.

The native QA reached the occupied tea place `leisure:tea` at `[12.9060509327, 0.47, 17.7954422625]` after 534 simulated 0.1-second updates, then returned to its original `[16.33, 0.57, -9.1]` home in another 639 updates. Both arrival and retained home ownership assertions passed. The native trip's minimum pairwise horizontal envelope clearance was **0.0501539494** scene units. These are accelerated simulation updates in the actual rendered app, not a claim that the journey ran at ordinary wall-clock speed; they supplement the ordinary-speed Node path assertions above.

The rendered crowd contained **42 visible bodies: 32 residents, four visitors and six meeting guests**. Its 800 simulated updates passed pairwise envelope checks with minimum clearance **0.0374187954**. Captures show the tea arrival in light and dark, the crowd overview in light, and the crowd at 375×812 in dark. The narrow document width was exactly 375px with no horizontal overflow. Appearance still requires the user's verdict.

## Historical rendering and memory comparison

Each cell below is one nominal eight-second sample, taken sequentially: reference 32, reference 42, candidate 32, candidate 42. Counts, viewport, camera target `[0,2,-8]`, zoom 1, assets and settings match. The desktop workload was uncontrolled; there is no repetition, randomization or steady-state/leak claim. The candidate's 42-body sample follows the tea trip, while the reference's does not, so allocation history and path/pose histories differ. These samples describe this run only and do not establish a performance improvement, regression threshold or Bao acceptance result.

| Measurement | Reference 32 | Candidate 32 | Reference 42 | Candidate 42 |
|---|---:|---:|---:|---:|
| Controller update p50 / p95, ms | 2.0 / 2.7 | 1.9 / 2.5 | 2.6 / 3.1 | 2.6 / 3.2 |
| CPU render submission p50 / p95, ms | 18.0 / 22.8 | 16.7 / 19.3 | 20.0 / 24.2 | 18.9 / 21.6 |
| Actual controller/render calls in sample | 238 | 241 | 239 | 241 |
| Browser animation-frame heartbeat p95, ms | 16.8 | 16.8 | 16.8 | 16.8 |
| CDP used JavaScript heap, MiB | 85.37 | 95.31 | 104.73 | 106.24 |
| CDP backing storage, MiB | 317.00 | 316.98 | 339.38 | 339.40 |
| Renderer geometries | 1,392 | 1,392 | 1,519 | 1,521 |
| Renderer textures | 115 | 115 | 125 | 125 |
| Draw calls per reported frame | 1,404 | 1,404 | 1,531 | 1,531 |
| Triangles per reported frame | 3,141,167 | 3,141,167 | 3,399,077 | 3,399,077 |

The animation-frame heartbeat is a separate browser callback, not rendered-frame cadence: its 475–482 callbacks exceeded the 238–241 actual render calls. CPU submission timings surround `renderer.render`; they are not GPU durations. Heap comes from `Runtime.getHeapUsage` without forced garbage collection, and backing storage is reported separately. Renderer resource counts are not physical VRAM. The two-geometry difference at 42 bodies was observed after the candidate-only tea trip; this run does not attribute its cause or establish a leak. No five-percent pass/fail decision is made from these measurements.

## Remaining gates

- A user decision on the proposed additional performance pass. Current independent code review passes the correction; QA bounces readiness for the measured native stalls. Further source changes need renewed independent verification.
- Formal security after QA passes, and completed green CI associated with the actual final source. Hosted CI acceptance remains unverified.
- User visual verdict on the six exact-candidate light/dark/narrow captures after responsiveness is resolved. Historical captures do not satisfy this gate.

The current authorization stops before merge or installed update.

No installed update is included. The implementation changes no service/router code, dependencies, office layout or outing scheduler contract; Jev/TypeSafe calls, purchases and waving remain outside its scope.
