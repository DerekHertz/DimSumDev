# Ticket 36: owned places and safe tea routes

**Current product candidate:** `1bac18101433119c2e0ce13d35b1ed79439e7a4e`, draft PR #383. The developer reports 121/121 covering checks, seven syntax checks and the production UI build passing in private board handoff `36-developer-14.md`. The root reports a final-candidate mounted unavailable-profile check passing 1/1. These are attributed results; this writer inspected source, diffs and saved receipts, and ran no tests or browser checks. The prior shared-navigation findings have source corrections and author coverage; a fresh independent pass is still pending. CI was in progress at the last check.

**Release blocker:** the final native capture records synchronous crowd admission of **28,356.4 ms**, 800 accelerated updates taking **23,271.2 ms**, and a single production update taking **8,038.2 ms**. Responsiveness remains unresolved. Neither the later idle samples nor the completed capture establishes performance or merge acceptance. Independent final assessment and a concrete performance recovery plan remain pending.

**Historical rendered evidence:** the measurements and captures below describe product source `d5b7128`, retained in `6bf4ada`. Independent review bounced `6bf4ada` for unsafe dynamic allocation and incomplete body/terrain clearance. Those captures do not verify the recovery candidate or provide its visual/performance sign-off. The installed-build reproduction record remains on the private board in `36-developer-2.md`; it describes an older pre-04 installed build and is not the comparison baseline.

## Current candidate native evidence

The root captured the actual app in native Chrome 155.0.8059.85 on 2026-10-21, from 14:52:05.517 to 14:54:13.159 UTC. Product source was `1bac181`; the comparison baseline was `20a854a81017637a6f074bb62782643fb6462454`. Both contain the same current Bao assets. The saved private receipt, preparation record and helper identify those sources. Raw captures and host paths stay private.

Both builds used actual model textures, 1440×900, DPR 1 and no reduced motion. The canvas measured 1384×856. The helper intercepted actor/camera modules for test-only events, held periodic snapshot rebinding during manual fixtures and called the original controller. It introduced no production debug interface. The final receipt records zero page errors and zero write requests, an owned browser closed, and both loopback servers closed.

All 32 initial candidate residents were visible with matching owned homes. After adding four visitors and six meeting guests, all 42 bodies were visible with matching owned homes. The 800-update crowd check recorded minimum horizontal envelope clearance **0.09185291** scene units. Per-actor identity, home owner, presentation, position, envelope and travel state were saved. Some actors remained safely staged or reported unavailable destinations; this does not establish completion of every crowd journey.

The actual QA reached owned `leisure:tea` after **570** simulated 0.1-second updates and returned to its retained home after another **677**. Minimum horizontal envelope clearance across that trip was **0.078482085** scene units. These were accelerated manual updates in the rendered app, not ordinary wall-clock travel.

Six real screenshots cover tea arrival in light/dark, the crowd overview in light, the crowd at narrow width in dark, an unavailable visitor profile in light, and an unavailable meeting profile at narrow width in dark. The unavailable fixture made navigation inaccessible and checked that ordinary and meeting bodies were hidden with no home/travel and truthful notes. Their native Team profiles still showed `Working`; the visitor's `View work` action was enabled. At 375×812, document width and scroll width were both 375px. The user has not given a visual verdict.

### Responsiveness and harness completion

Crowd admission blocked synchronously for **28,356.4 ms**: `applyLive` took **6,632.1 ms** and `applyMeeting` took **21,724.2 ms**. The following 800 updates took **23,271.2 ms**, with a maximum single production update of **8,038.2 ms**. Initial candidate allocation separately took **5,692.3 ms**. These stalls remain a release blocker even though later samples have low update p95 values.

The first full native attempt failed its 35-second aggregate crowd deadline. Saved fixture work took about 53 seconds, so the private harness raised that step to 90 seconds inside the unchanged 240-second whole-capture deadline. All 800 updates, safety assertions and product work ceilings remained. The second attempt completed with phase timings. That change fixed harness completion; it did not fix the measured product stalls.

### Current rendering and memory comparison

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

- Fresh independent code review and QA at the final candidate, including test-guard findings and the recorded runner incident.
- Risk/security and completed green CI checks; last reported CI state was in progress.
- Independent assessment of the native stalls and memory increase, followed by a concrete performance recovery plan. Responsiveness remains unresolved.
- User visual verdict on the six final light/dark/narrow captures. Current mounted/native checks and descriptive comparison are recorded above; historical captures do not satisfy this gate.

The current authorization stops before merge or installed update.

No installed update, service or router action, Jev/TypeSafe call, new dependency, purchase, office expansion, outing scheduler redesign or waving feature was part of this work.
