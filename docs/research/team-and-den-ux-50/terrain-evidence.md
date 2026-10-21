# Terrain-clearance extraction

This slice improves the shared terrain map and walk-mode clearance. It does not
complete owned resident homes, visitor admission, crowd avoidance or safe tea
round trips. Existing actor, daily-routine, resident-home, garden-route, shell
and overlay code is unchanged from main `20a854a81017637a6f074bb62782643fb6462454`.
PR 383 remains preserved at `f69a9e205e176b34c6b740e41fc6d2bdc0915a74`.

Production candidate `2d8f86d7739ce91b2b2c51004ca43677fadee181` changes
only four production files: `navigation.mjs`,
`garden-navigation.mjs`, `crafted-architecture.mjs` and `plush/tea-garden.mjs`.
The map checks every raster cell touched by a disc, distinguishes authored
support from solid furniture, preserves source-solid boundaries across material
batching and excludes actual water/field geometry. Exact-query caching includes
position, prior height, radius and body height; it never shares a verdict across
different queries. No layout or render-buffer change is intended.

## Focused evidence

Before production extraction, the imported navigation and curved-stream
regressions ran on main: 2 passed and 8 failed on assertions. After extraction,
53 tests passed across 10 explicit files with concurrency 2 and a 300-second
bound (11.922 seconds, no skips or cancellations):

- `meshy/navigation.test.mjs`, `meshy/terrain-geometry.test.mjs`
- `meshy/garden-route.test.mjs`, `meshy/stylized-structures.test.mjs`
- `meshy/resident-homes.test.mjs`, `meshy/actors.test.mjs`
- `meshy/daily-routines.test.mjs`, `meshy/bao-acceptance.test.mjs`
- `meshy/bao-production.test.mjs`, `assets-src/den/actual-navigation.test.mjs`

The final geometry test was then strengthened with independent rendered-water
checks for the pond and flooded field; that file passed again (1/1, 2.138 seconds).
Its oracle reads source triangles without consulting navigation metadata.
The other passing tests and production source were unchanged. UI build, seven
syntax checks and the whitespace diff check passed. These are the saved developer
results; this documentation update changes no production or test bytes. Existing
assertions, render budgets and compatibility fixtures are retained.

## Native comparison

The orchestrator captured one sequential native comparison of base `20a854a`
and candidate `2d8f86d`, with 32 visible actors in each. The production walk
controller made 218 calls through the Pass entrance, stairs and interior, then
returned over identical visited points. Maximum walk-call time was 0.5 ms for
the candidate and 0.8 ms for base. Both rejected the furniture and pillar probes.
At the curved-stream probe, base admitted ground at 0.26 and the candidate
rejected it. Unit regressions separately cover overhead clearance.

Each settled sample lasted eight seconds and captured 240 actor updates.
Candidate update p95/max was 2.5/3.5 ms, versus 2.8/3.9 ms for base. Actor
construction took 4.1 ms versus 2.4 ms. Complete asynchronous world creation,
including asset loading and setup, took 2855.3 ms versus 2582.5 ms; this is not
a synchronous navigation CPU or freeze measurement. Render counts matched at
1386 calls and 3113490 triangles. This uncontrolled sequential sample supports
no percentage-regression, GPU or leak claim.

Light and dark overview captures and a walk-mode capture were saved. The native
run reported no browser errors or writes. Its browser and servers closed;
both owned server ports refused connections in the saved cleanup check.

## Outstanding gates

Independent review, QA, normal CI and risk assessment remain outstanding. The
native sample and saved captures await the user's visual verdict before merge.
No installed update is included.
