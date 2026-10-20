# Two-character proof: before/after measurement (team-and-den-ux/23)

Recipe from `team-and-den-ux-22/two-character-proof-plan.md`: RTX 3060 Ti, Windows Chrome 155.0.8059.85 (headless, ANGLE D3D11), instrumented production build, 1440×900 at DPR 1, 30 fps cap, 10 scenarios (idle, crowded, meeting, walk and reduced motion; light and dark) × 3 repeats, 10 s warm-up, 30 s sample. Before: `origin/main` 3465b89. After: the branch at 773157e. The two captures ran back to back with nothing else heavy on the box. Neither run had page errors or write requests.

Full per-scenario medians: `before-after.json`.

## Pooled over all 30 runs

| Metric | Before | After | Change |
|---|---|---|---|
| Mean delivered FPS | 29.96 | 29.99 | none |
| GPU p95, all samples pooled | 20.0 ms | 18.4 ms | −8% |
| GPU p50, all samples pooled | 14.5 ms | 10.2 ms | −30% |
| Median of per-run GPU p95 | 17.5 ms | 16.0 ms | −9% |
| Render CPU p95, pooled | 23.0 ms | 21.3 ms | −7% |
| Main-view draw calls, median | 1,561 | 1,446 | −7% |
| JS heap used, median | 402.7 MiB | 393.4 MiB | −2% |

## Scene memory (idle, same in every scenario)

| Metric | Before | After | Change |
|---|---|---|---|
| Scene triangles | 3,238,257 | 3,145,807 | −2.9% |
| Resident triangles | 1,025,048 | 932,598 | −9.0% |
| Geometry buffers | 272.6 MiB | 265.3 MiB | −2.7% |
| Estimated texture memory (RGBA8 + mips) | 64.8 MiB | 67.5 MiB | +2.67 MiB |

## Reading

- The GPU timings are bimodal on this box: whole runs sit at about 10 ms or about 18 ms p95. That is most likely a GPU clock state. So single scenarios swing ±40% between repeats in both directions. The dark idle, crowded and walk scenarios have 3-run medians 10–13% worse. Their before runs spread over 15–19.5 ms and their after runs over 9.6–19.2 ms, so these swings are within that noise, not a trend. The pooled figures, over all 30 runs and 9,000 samples, all improve.
- Texture memory rises by exactly the two new 512×512 atlases (2 × 1.33 MiB), which is the plan's allowance for the pair. The Bao body textures stay loaded because every other role still uses them, so this cannot drop until more of the cast is replaced.
- Every other memory and geometry figure falls. The two species are about 8.3k triangles each, against the roughly 32k of the panda and outfit they replace.
