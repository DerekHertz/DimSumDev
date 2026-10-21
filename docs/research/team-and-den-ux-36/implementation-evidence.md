# Ticket 36: owned places and safe tea routes

**Historical candidate evidence.** Independent review bounced `6bf4ada` for unsafe dynamic allocation and incomplete body/terrain clearance. The measurements and captures below describe its earlier `d5b7128` product source. They do not verify the correction currently in progress; that source needs fresh focused, rendered and performance evidence before visual approval or delivery.

This is implementation evidence for review, not visual or performance sign-off. The installed-build reproduction record remains on the private board in `36-developer-2.md`; it describes an older pre-04 installed build and is not the comparison baseline. Native evidence below uses the current 04 shell and actual rendered assets.

## Implemented behavior

The scene has one place registry for work, meeting, leisure, visitor and staging places. Leases follow the complete project/runtime/role/agent/ticket identity, including a resident's takeover identity. Work homes stay reserved during trips. Departing occupied temporary places stay owned until the body clears them; visitor removal and scene disposal release all of that actor's leases.

The common traveller validates the actual rig, outfit, carried props, leisure gestures and published replacement envelopes. It checks the swept path, terrain and overhead clearance, including final approaches and reduced-motion placement. Allocations use distinct fitting overflow or safe staging rather than a shared fallback. Staging or route failure appears separately from real agent state; presentation availability does not gate execution admission.

Yielding retains a stable full-identity winner until remaining swept routes separate or that winner finishes, cancels or disappears. Route and detour attempts share a three-attempt limit. Repeated requests and unrelated registry changes do not reset an exhausted trip; changes to that specific destination or navigation revision can reopen it. The routine scheduler retains failed-target state across routine-slot cleanup; the existing departure timing and three-outing cap remain.

## Shipped-model assembled trip

Reproduce with:

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

## Assembled crowd

The same production fixture then adds four concurrent visitors and six busy-role meeting guests: 42 actors total. It checks 800 updates (80 simulated seconds), pairwise horizontal body separation at every update, truthful owned arrival states, and complete visitor-lease removal when those runs end. The minimum observed clearance was **0.0374187954** scene units. At the end, three meeting guests were still moving; this evidence does not claim every crowd journey completed within that interval.

## Covering checks

Independent runner smoke passed **54/54** tests across `actors`, `owned-places`, `owned-trip`, `owned-places-geometry`, `daily-routines`, `garden-route`, `navigation`, and `proximity-card`, with concurrency 2. Ten changed JavaScript modules passed `node --check`. The production UI build passed; its existing large-chunk warning remains.

The retained crossing regression still uses 200 × 0.1-second updates, separation ≥0.8−0.001, actual yielding and both arrivals, in both input orders. Additional cases cover winner cancellation/disposal, a blocked narrow corridor stopping after three attempts, home retention on failure, relevant-only retry reopening, paired runtime/project identities, unavailable routes, held cards, meeting/tool identity, and exact travel speed/gait. Representative tail, shell and antler envelopes remain covered by the geometry tests.

The legacy unreachable reduced-motion meeting test now requires the actor to stay safely put and report unavailability. Its retry coverage now checks exactly three attempts plus stable query counts after exhaustion, rather than assuming a fixed number of internal allocation queries. The held tea visitor test now uses the actual actor ID so it holds the correct runtime's body.

## Native rendered scene and trip

One bounded native Chrome 155.0.8059.85 capture completed on 2026-10-21 from 00:35:20.753 to 00:36:32.440 UTC. It served the unmodified candidate `d5b712811a1efc46f9f99eea50213ded66e065d0` and reference `3d1aa13` from separate worktrees. Both used the actual current-04 app, all model textures, a 1440×900 viewport, DPR 1, light theme for measurements, no reduced motion and synthetic read-only snapshots. The canvas was 1384×856 within the 44px top bar and 56px rail. Both species replacements loaded successfully. There were no browser page errors or write requests.

The capture harness intercepted only the served actor and camera modules to emit test-only DOM events. Controller and camera references stayed in the init-script closure. It suppressed periodic snapshot rebinding during manual fixtures, but called the original controller and rendered the real scene. There are no production debug globals, source hooks, renderer stubs or installed-service changes. File-based helpers and raw captures stay private, with their exact paths recorded in the developer handoff.

The native QA reached the occupied tea place `leisure:tea` at `[12.9060509327, 0.47, 17.7954422625]` after 534 simulated 0.1-second updates, then returned to its original `[16.33, 0.57, -9.1]` home in another 639 updates. Both arrival and retained home ownership assertions passed. The native trip's minimum pairwise horizontal envelope clearance was **0.0501539494** scene units. These are accelerated simulation updates in the actual rendered app, not a claim that the journey ran at ordinary wall-clock speed; they supplement the ordinary-speed Node path assertions above.

The rendered crowd contained **42 visible bodies: 32 residents, four visitors and six meeting guests**. Its 800 simulated updates passed pairwise envelope checks with minimum clearance **0.0374187954**. Captures show the tea arrival in light and dark, the crowd overview in light, and the crowd at 375×812 in dark. The narrow document width was exactly 375px with no horizontal overflow. Appearance still requires the user's verdict.

## Descriptive rendering and memory comparison

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

- User visual verdict on the actual light/dark/narrow captures.
- Fresh independent code review, QA including each test-guard finding and these evidence limits, risk/security checks where applicable, then delivery checks.

No installed update, service or router action, Jev/TypeSafe call, new dependency, purchase, office expansion, outing scheduler redesign or waving feature was part of this work.
