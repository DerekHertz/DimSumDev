# Terrain-clearance extraction

This slice improves the shared terrain map and walk-mode clearance. It does not
complete owned resident homes, visitor admission, crowd avoidance or safe tea
round trips. Existing actor, daily-routine, resident-home, garden-route, shell
and overlay code is unchanged from main `20a854a81017637a6f074bb62782643fb6462454`.
PR 383 remains preserved at `f69a9e205e176b34c6b740e41fc6d2bdc0915a74`.

Only four production files are extracted: `navigation.mjs`,
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
bound (11.9 seconds, no skips or cancellations):

- `meshy/navigation.test.mjs`, `meshy/terrain-geometry.test.mjs`
- `meshy/garden-route.test.mjs`, `meshy/stylized-structures.test.mjs`
- `meshy/resident-homes.test.mjs`, `meshy/actors.test.mjs`
- `meshy/daily-routines.test.mjs`, `meshy/bao-acceptance.test.mjs`
- `meshy/bao-production.test.mjs`, `assets-src/den/actual-navigation.test.mjs`

The final geometry test was then strengthened with independent rendered-water
checks for the pond and flooded field; that file passed again (1/1, 2.1 seconds).
Its oracle reads source triangles without consulting navigation metadata.
The other passing tests and production source were unchanged. UI build passed.
Existing assertions, render budgets and compatibility fixtures are retained.

## Outstanding gates

Independent review, QA, normal CI, risk assessment and the matching native
walk-mode/reference comparison remain outstanding. The native check must cover
entrances, stairs, water, overhead clearance, startup and worst observed update
timing. These unit results establish neither interactive responsiveness nor a
visual verdict. The user supplies the visual verdict before merge; no installed
update is included.
