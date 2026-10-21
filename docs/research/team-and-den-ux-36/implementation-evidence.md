# Ticket 36: owned places and safe tea routes

This is implementation evidence for review, not visual or performance sign-off. The installed-build reproduction record remains on the private board in `36-developer-2.md`; it describes an older pre-04 installed build and is not the comparison baseline.

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

## Remaining evidence and gates

- Native light/dark/narrow captures of the actual 04 shell and integrated scene, followed by the user's visual verdict.
- A matched reference-box comparison against `3d1aa13`, using the same current-04 shell, settings and synthetic 32/42 actor counts. No rendering performance or memory conclusion is made by the geometry tests above.
- Fresh independent code review, QA including each test-guard finding, risk/security checks where applicable, then delivery checks.

No installed update, service or router action, Jev/TypeSafe call, new dependency, purchase, office expansion, outing scheduler redesign or waving feature was part of this work.
