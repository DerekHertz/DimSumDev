# Bao24 matched hardware comparison

## Reuse decision, declared before continuation

Frozen `performance-paused-45-runs.json` remains byte-for-byte intact, SHA256 `9f4bdcfd468b39c3e8264df670f4859aee181e5d88853f6e9ef15f01bd9af734`. The resumed selection was recorded in external `resumed/resume-plan.json`, SHA256 `120f9cc6d53d5d38b955edcc4104197b509810ae87d077869cc008dd07e13c14`, before any new full samples. Retain rows0–43, preserve old unpaired row44 as a diagnostic only, and recollect both members of rep3 crowded-light plus the seven remaining pairs. This yields44 saved +16 new =60; selection depends only on the interruption boundary.

The same retained production build under `/tmp/den-cast-24-acceptance` is served without recompilation. Its61 files are hashed in the plan. Production UI, lockfile, original observer build script and `capture-review.cjs` are unchanged from source `efbb225f9569abeb269cd052236dac426c4d9af4`. Original external `native-performance.cjs` SHA256 `411748eede9c54617f48f212d71c031108e1e0f42c30ca004ef71c7fe3b2b13c` and `capture-review.cjs` SHA256 `c515ba0c9f420460c0adc76159ccff6a2a1b5d56751e222702ebcb02d3bfd315` matched their frozen tracked copies before resume changes. The resumed harness adds selection, metadata checks and a bounded deadline; GPU/render/animation collection and timing are unchanged.

Before is the original shipped Bao, selected by removing only `characters.bao` from the manifest before world load, with the original portrait. Original body/wardrobe URLs and loaded assets remain unchanged; rejected local art and failed-load fallback are never baselines. See `acceptance.md` for the original body hash and fallback/action/disposal evidence.

All45 frozen rows passed hardware/count/sample/disjoint/timestamp validation. Native preflight then matched Chrome155.0.8059.85, RTX3060Ti, NVIDIA driver32.0.16.1742, ANGLE Direct3D11,1440×900 viewport,1384×856 canvas and DPR1. The native Node executable is the established absolute path; resumed version is22.20.0. Original raw did not record Node's version. Node only controls the unchanged browser collector; the exact retained instrumented build and browser are the measurement runtime. The preflight's two short rows are metadata diagnostics, never acceptance samples.

The retained source fixes shadows,30fps demand rendering, camera, fixtures and reduced-motion behavior identically on both sides. Fixtures have32/36/42 actors for idle/crowded-or-walk/meeting-or-reduced scenarios. Each full run uses10s warmup +30s measurement, >800 real frames, >250 hardware GPU queries and zero disjoint queries. Three matched repeats alternate before/after order (rep2 reversed). One owned Chrome runs at a time; the benchmark launches no other test browser or test suite during capture. NVIDIA clocks/P-state/power/temperature are sampled every5s and remain observed, never pinned.

## Analysis method

Nearest-rank percentiles use `sorted[ceil(n*p)-1]`. Scenario comparisons use the median of three per-run p95 values for each appearance; pooled sample distributions and every individual run are retained. GPU and combined render/animation CPU p95 must each stay within+5%; median GPU target is<16.7ms. Resource counts/steady heap must not increase apart from the separately approved single atlas.

Combined CPU charges every named animation callback between rendered frames to the following render, then adds that render's measured CPU. Monotonic timestamps and complete `update/pose/update` cycles validate the unchanged production order: `agents.update`, `ambient.pose`, `koi.update` immediately precede rendering. No tail callbacks may be silently discarded. This excludes unrelated browser/UI/React work; it is not total main-thread or whole-app CPU. GPU queries measure the real renderer call. Delivered FPS alone cannot pass the comparison because both appearances have the same30fps cap.

## Results

**FAIL: the replacement does not meet the approved per-scenario +5% acceptance limits.** All60 full runs are valid, with zero page errors, writes, disjoint queries or unresolved queries. No rows were discarded for performance, and no threshold was changed. Every selected scenario median GPU p95 is below16.7ms. This is evidence completion, not replacement acceptance.

| Scenario | GPU p95 before → after (ms) | Change | Combined CPU p95 before → after (ms) | Change |
| --- | --- | --- | --- | --- |
| idle-light | 13.516 → 13.379 | -1.02% | 16.800 → 16.500 | -1.79% |
| idle-dark | 13.460 → 14.829 | +10.16% | 17.300 → 18.600 | +7.51% |
| crowded-light | 15.027 → 14.556 | -3.13% | 18.700 → 18.400 | -1.60% |
| crowded-dark | 14.975 → 14.013 | -6.42% | 18.500 → 17.800 | -3.78% |
| meeting-light | 9.328 → 11.765 | +26.13% | 19.300 → 20.000 | +3.63% |
| meeting-dark | 17.407 → 15.117 | -13.15% | 19.700 → 21.500 | +9.14% |
| walk-light | 13.199 → 13.591 | +2.96% | 16.500 → 16.700 | +1.21% |
| walk-dark | 13.977 → 13.796 | -1.29% | 17.600 → 17.200 | -2.27% |
| reduced-light | 16.492 → 15.514 | -5.93% | 20.500 → 19.300 | -5.85% |
| reduced-dark | 15.442 → 16.256 | +5.27% | 19.300 → 20.000 | +3.63% |

All three repetitions remain in each median. The full raw distributions, separate render/agents/ambient/koi CPU distributions, per-run p95s, heap, cameras and clock traces are in `performance-statistics.json` and the external raw/summary files hashed in `acceptance-receipt.json`. An independent runner recomputed all ten scenario GPU/CPU results and aggregate resource medians without importing the summarizer; they matched.

| Aggregate metric | Original | Selected |
| --- | ---: | ---: |
| Pooled GPU sample p95 (ms) | 16.188 | 16.113 |
| Pooled combined CPU sample p95 (ms) | 20.400 | 21.300 |
| Median steady GC heap (bytes) | 375979544 | 372665253 |
| Median unique geometry buffers (bytes) | 287309720 | 284631406 |
| Median scene triangles | 3237085 | 3209408 |
| Median real draw calls | 1446 | 1428 |
| Median delivered FPS | 29.985 | 29.985 |

Pooled GPU p95 changes−0.47%; pooled combined CPU p95 changes+4.41%. These pooled figures do **not** override failing scenarios. Both appearances retain26,949 render frames; GPU samples8,989 original /8,990 selected. Per-run frame counts863–903 and GPU counts288–301 satisfy the full-sample guard. All434 NVIDIA samples showP0, graphics1,755MHz and memory9,701MHz, temperatures44–47°C.

Delivered FPS scenario-median changes range−0.0545% to+0.1118%; pooled median29.98476→29.98506. Walk-light selected median is0.000100fps below the lowest original repetition; its median-to-median decline0.000300fps is smaller than the original repetition spread0.000532fps. This literal baseline-min diagnostic remains false in the statistics; the30fps cap is not an acceptance argument. Individual slow runs (including selected meeting-light rep3 at28.735fps) remain visible.

The single additional atlas remains the previously approved1,398,100-byte GL-requested storage allocation. Scene material-dimension estimates rise70,740,650.67→72,138,752 bytes (estimate delta1,398,101.33); those estimates are neither exact GL allocation nor driver VRAM. Renderer texture count was116→117 in the prior matched disposal evidence. No other resource allowance is inferred.

## Bounded diagnosis; cause unresolved

The captured-data acceptance assertion reproduces all five failed gates. Independent arithmetic eliminated percentile/callback-accounting error as an explanation. No incomplete GPU queries or callback tails exist. Repetition variability is substantial despite fixed GPU clocks; it is evidence to investigate, not grounds to remove runs or call this a pass.

| Failing scenario | Original GPU p95 reps1/2/3 (ms) | Selected GPU p95 reps1/2/3 (ms) | Original combined CPU reps1/2/3 (ms) | Selected combined CPU reps1/2/3 (ms) |
| --- | --- | --- | --- | --- |
| idle-dark | 9.541 / 13.460 / 13.909 | 9.566 / 14.829 / 18.381 | 12.400 / 17.300 / 17.600 | 12.800 / 18.600 / 23.900 |
| meeting-light | 9.328 / 16.695 / 5.026 | 11.765 / 17.071 / 4.321 | 19.100 / 19.300 / 25.800 | 14.200 / 20.000 / 31.700 |
| meeting-dark | 17.318 / 17.407 / 17.844 | 15.117 / 16.856 / 4.446 | 19.700 / 19.400 / 23.700 | 21.600 / 19.500 / 21.500 |
| reduced-dark | 16.559 / 15.442 / 15.393 | 23.425 / 15.759 / 16.256 | 20.800 / 19.300 / 18.700 | 29.400 / 19.600 / 20.000 |

Read-only native `material-profile.json` verifies actual loaded flags, rather than the geometry-only CPU decoder: both are opaque MeshStandardMaterial, opacity1, DoubleSide, depthWrite/depthTest true, alphaTest0, alphaHash false, no normal map, metalness0. `forceSinglePass=false` on both is irrelevant to Three’s two-pass transparent branch because transparent=false. Both have one26-bone skeleton; skin castShadow=true/receiveShadow=false/frustumCulled=false. Both use the same2048 PCF shadow, auto-update frequency, lights, camera and18 compiled programs. Original actor has21 meshes including costume/tool/badges; selected has3 including the shared80 unskinned triangles. Original body atlas1024²/.8roughness versus selected512²/roughness1. No duplicate selected skin, extra skeleton, transparency pass or changed shadow frequency was found.

Combined CPU includes all actors; no per-Bao CPU attribution was captured. Unchanged ambient.pose also varies between appearances, and the raw GPU range is not explained by graphics clocks alone. A causal profile or controlled diagnostic remains necessary before a local performance correction can be justified. No artwork/material/runtime correction, new paid stage or new full acceptance dataset was attempted after this first bounded diagnosis. Root owns the next profiling/correction decision and final user fitting/performance verdict.

Native Node22.20.0 executable mtime2025-09-24, Chrome executable mtime2026-10-15 and Playwright package mtime2026-10-20T02:53 predate both capture segments. Runtime hashes are in the receipt; original raw omitted Node version, so a historical binary hash is not claimed. All owned browser sessions closed successfully; both owned server instances were stopped and4425 verified closed.

Verification: five resume/metadata/assembly/CPU-alignment tests plus two summarizer acceptance tests pass. New summary tests fail against the prior unverified script (including acceptance of a59-run partial summary), then pass with the corrected guards. Runner syntax checks passed for the five analysis/capture scripts; the added read-only profile script also passed syntax. Prior129 unique focused product checks and23 covering rerun remain unchanged and were not rerun.


## Observed-state and host audit

All eight stationary scenarios record identical observed OrthographicCamera position `[0,65.50852961085883,89.81462390204986]`, target `[0,2,0]`, zoom1,1384×856 drawing buffer and CSS dimensions across their six runs. Counts are exactly32/0visitor/0guest (idle),36/4/0 (crowded/walk),42/4/6 (meeting/reduced); input agents0 or12 as specified. Per-appearance scene/garden triangles, shadow triangles, unique geometries and buffer bytes remain identical across all repetitions. Static draw totals are stable: idle1404→1386, crowded1446→1428, meeting1537→1519, reduced1533→1515. These observations rule out a static camera/count/draw-count mismatch in the failed cases.

Walk mode records PerspectiveCamera x0/y2.08, with final z26.26444–26.29993 in light and26.250055–26.30014 in dark. Endpoints vary with elapsed movement timing; draw totals therefore change along the path (original1195–1325, selected1177–1307). Camera world/projection matrices, rotation, exact pose quaternions/phase and actual matchMedia values were not captured. Motion/theme inputs and source are identical, but exact observed pose equality is not proven; none of the five failing gates are walk scenarios. `observed-audit.json` retains each recorded camera/count/workload row.

Historical NVIDIA telemetry contains clocks, power and temperature, **not utilization or process activity**. Before power mean82.484W/p95 83.77/range80.44–84.80; after82.302W/p95 83.27/range81.26–84.29. Graphics/memory clocks are fixed across recorded samples; that alone does not prove a quiet host. A post-capture snapshot at21:20:22UTC shows2% GPU/1% memory utilization,73.42W,43°C and unrelated GPU clients including Chrome PIDs7100/15688, Codex, Claude, Teams, WebView, NZXT CAM and iCUE. It contains names/PIDs only, with no command-line or environment inspection; no unrelated process was stopped. This snapshot cannot establish historical contention or quietness. The historical acceptance run’s quiet-host condition remains unverified; the user later reported other GPU workloads closed before the separate diagnostic captures below.

`gpu-host.json` and `observed-audit.json` are separately hashed in the receipt and never count as acceptance samples. No concrete local harness bug or causal asset regression was identified. The failed numeric gates stay failed; root owns the next scoped profiling/quiet-host decision.

## CPU failure component attribution

Per-run p50/p95 values below keep render CPU and the timestamp-aligned sum of all three named animation callbacks separate. Marginal p95 values cannot be added to recover combined p95. These are whole-scene callbacks, not isolated Bao timings.

| Scenario | Rep | Appearance | Render p50 / p95 (ms) | Summed animation p50 / p95 (ms) |
| --- | ---: | --- | --- | --- |
| idle-dark | 1 | original | 9.10 / 10.90 | 1.40 / 1.70 |
| idle-dark | 1 | selected | 9.10 / 11.30 | 1.40 / 1.70 |
| idle-dark | 2 | original | 13.30 / 15.70 | 1.40 / 2.00 |
| idle-dark | 2 | selected | 13.00 / 16.80 | 1.50 / 2.20 |
| idle-dark | 3 | original | 13.30 / 15.90 | 1.40 / 1.90 |
| idle-dark | 3 | selected | 13.20 / 21.20 | 1.70 / 2.70 |
| meeting-dark | 1 | original | 13.50 / 17.40 | 1.90 / 2.40 |
| meeting-dark | 1 | selected | 16.00 / 19.00 | 1.90 / 2.70 |
| meeting-dark | 2 | original | 14.90 / 17.30 | 1.80 / 2.30 |
| meeting-dark | 2 | selected | 15.00 / 17.50 | 1.80 / 2.30 |
| meeting-dark | 3 | original | 16.60 / 20.90 | 2.30 / 3.00 |
| meeting-dark | 3 | selected | 15.90 / 18.90 | 2.30 / 2.90 |

Idle-dark median-of-three render p95:15.70→16.80ms; summed-animation p95:1.90→2.20ms. Meeting-dark render p95:17.40→18.90ms; summed-animation p95:2.40→2.70ms. Both render and animation timings contribute; no local Bao-only cost can be isolated from these samples. Named agents/ambient/koi component p50/p95 values for every repetition are retained in `cpuFailureComponents` and external `cpu-components.json`.

Historical checkpoint before the user’s Ready response (superseded): no further timing run was then authorized. The user subsequently confirmed other GPU workloads closed, enabling the separate quiet-host and original/original diagnostics below. The failed60-run baseline stays preserved; no production/art/budget change was made.

## User-ready quiet-host diagnostic, separate from acceptance

After the user answered Ready and reported other GPU workloads closed, root authorized one bounded diagnostic: meeting-light only, three matched repetitions,10s warmup +30s samples, rep2 reversed, unchanged source/art/build/collector. Its predeclared plan, six complete rows and summary are under `quiet-diagnostic/`; the original failed60 rows are unchanged. Five-second telemetry now includes total GPU/memory utilization. This is not a new acceptance dataset or a replacement for any failed sample.

| Rep | Appearance | GPU p95 (ms) | Combined CPU p95 (ms) | Render frames | GPU samples |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | original | 22.345728 | 28.70 | 886 | 296 |
| 1 | selected | 16.555008 | 18.50 | 900 | 300 |
| 2 | selected | 16.731136 | 19.40 | 900 | 300 |
| 2 | original | 16.816128 | 19.50 | 900 | 300 |
| 3 | original | 3.972096 | 19.50 | 901 | 301 |
| 3 | selected | 16.141312 | 19.00 | 900 | 300 |

Median-of-three GPU p95:16.816128→16.555008ms (−1.55%); combined CPU p95:19.50→19.00ms (−2.56%). All six rows pass full-sample/disjoint/query/timestamp checks, with zero errors/writes and identical observed camera,42actor/4visitor/6guest counts, layout and driver. Actual draw totals remain1537 original/1519 selected. Graphics/memory stay1,755/9,701MHz/P0; GPU utilization11–17%, memory3–4%, power81.09–82.33W, temperature44–45°C.

The original GPU p95 still spans3.972096–22.345728ms, versus16.141312–16.731136 selected. Original rep3 records GPU3.972096ms and CPU19.50ms, while matched selected records GPU16.141312ms and CPU19.00ms with the same camera/counts and similar utilization. Variability persists under the user-reported quieter condition. This does not isolate host, timer/driver or asset cost, and no causal conclusion is claimed. Root should settle a focused measurement/profile diagnostic before spending another full acceptance run. No full60 rerun, production correction or budget change was started.

The diagnostic raw retains the generic harness recipe label mentioning10scenarios; its explicit diagnostic kind, predeclared one-scenario plan, filtered harness and observed six rows establish the actual diagnostic scope. The label is not used to claim completion of a second full recipe. Native browser exited successfully; owned diagnostic serverPID32282 stopped and4425 closed.

An independent runner also recomputed all six quiet-diagnostic GPU/combined CPU p95 values, medians and camera/count/draw consistency; they match the saved diagnostic summary. Its inline recomputation and output were not saved.

The subsequent [original/original control](identical-control.md) exposes a29.07% apparent GPU improvement between identical asset labels, while combined CPU differs−0.62%. Its six rows remain separate; this failed60-run acceptance verdict is unchanged. Root owns the next bounded native tracing continuation; no full rerun was started.
