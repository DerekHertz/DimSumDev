# Bao original/original control

This separate predeclared diagnostic keeps the failed60 acceptance rows and quiet6 rows untouched. It uses meeting-light, three pairs ordered AB/BA/AB,10s warmup +30s sample, the same retained build/browser/collector and a seven-minute deadline. **Both labels load original shipped Bao.** Every row records the manifest `characters.bao` key absent, original model URL requested, selected model URL absent, null replacement species and zero failed loads. The `baseline` Boolean is an A/B label only in this diagnostic; the saved raw bytes are never fed into acceptance reporting.

All six rows completed with zero errors/writes/disjoint/pending queries,865–904frames and289–302GPU samples. Observed scene resources, camera,1384×856 canvas and42actor/4visitor/6guest counts match exactly. Exact animated pose phases and per-frame GPU busy attribution remain unobserved. External `identical-control/` preserves plan, raw, harness and screenshots; tracked `identical-control-statistics.json` retains distributions and comparisons.

| Order | GPU p50 / p95 ms | Render CPU p50 / p95 ms | Animation sum p50 / p95 ms | Combined CPU p50 / p95 ms |
| --- | --- | --- | --- | --- |
| rep1 A | 11.038720 /13.437952 | 10.60 /13.60 | 1.80 /2.20 | 12.50 /15.80 |
| rep1 B | 3.728384 /11.215872 | 10.40 /13.70 | 1.80 /2.10 | 12.20 /15.60 |
| rep2 B | 3.730432 /9.453568 | 10.60 /14.20 | 1.80 /2.20 | 12.40 /16.30 |
| rep2 A | 3.729408 /11.745280 | 10.50 /14.10 | 1.80 /2.20 | 12.30 /16.10 |
| rep3 A | 11.141952 /14.680064 | 10.70 /14.30 | 1.80 /2.20 | 12.50 /16.40 |
| rep3 B | 3.862528 /9.531392 | 10.30 /13.60 | 1.80 /2.20 | 12.00 /16.00 |

Median-of-three GPU p95 A13.437952→B9.531392ms: **−29.07% apparent improvement with identical Bao**. Paired B-relative-to-A changes are−16.54%,−19.51%,−35.07%. No forward apparent >+5% regression occurred; the opposite sign still exposes differences far beyond the margin. GPU p95 spans9.453568–14.680064ms. Render CPU median p95 changes14.10→13.70ms(−2.84%), animation2.20→2.20ms(0%), combined CPU16.10→16.00ms(−0.62%). Marginal CPU p95s must not be added. Exact values and named callback components remain in the statistics.

Telemetry retains1755/9701MHz/P0, GPU utilization4–17%, memory1–4%, power73.48–82.76W,44–46°C. Rep2 A has865frames and maxima151.23ms GPU,231.70ms render,289.40ms combined CPU; a4% utilization sample also occurs. These observations do not establish a shared cause. Every spike, pair and tail remains. No recapture was attempted. Native browser exited0; owned serverPID64019 stopped and4425 verified closed. No service or unrelated process was controlled.

The unchanged A/A recipe is **not repeatable within5% for GPU comparison** under the user-reported quiet condition. This does not establish a driver, submission, browser scheduling/GC, pose-phase or device-scheduling cause, and it does not absolve selected Bao. The original60-run acceptance gates remain failed. No art/runtime change, Meshy spend, threshold waiver or full60 rerun occurred.

## Next scoped profiling step

Root authorized a separate continuation after this handoff; no more captures were launched under this claim. Proposed diagnostic: at most two original-Bao meeting-light runs, each10s warmup +30s sample, three-minute overall bound, trace output cap256MiB. Trace only the owned native test browser using minimal Chrome categories `devtools.timeline`, `v8`, `gpu`, and, if available, `disabled-by-default-gpu.service`. Report category coverage. Exclude screenshots, network bodies, input events, environment/credentials and unrelated applications. Keep source/browser flags/elapsed-query placement/every-third-frame frequency/sample guards unchanged.

Record diagnostic frame/query identifiers, CPU-side begin/end/submission timestamps and query availability lag to correlate existing elapsed intervals with renderer/main-thread tasks, V8/GC and GPU-process scheduling. No `flush`, `finish`, synchronous query waits, scheduling change or replacement GPU metric. Trace overhead makes these diagnostic-only. Correlations may narrow cause; Windows device-busy attribution may still require a separately agreed native GPU trace.

Before a new full60 capture, propose a preregistered repeatability guard after any justified correction: three original/original pairs AB/BA/AB, all rows retained, same10s+30s/full-sample guards, observed camera matrices/counts and pose-state evidence. Require absolute A/B median-of-three p95 differences≤5% for GPU and combined CPU and absolute paired differences≤5% for both. Failure holds the full rerun; no best-of selection or automatic retry. Root/user should agree this diagnostic guard and any collector/protocol revision before execution. Approved asset limits stay unchanged, and any later acceptance dataset remains separate from failed60.

Primary-source interpretation: [WebGL elapsed-query extension](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/) defines elapsed timing and disjoint validity; [ANGLE D3D11 Query11.cpp](https://chromium.googlesource.com/angle/angle/+/9d737966acdf628a7cb4e12e4781179ea3be5d7b/src/libANGLE/renderer/d3d/d3d11/Query11.cpp) uses begin/end GPU timestamp differences. These intervals are not continuous GPU busy time. CPU/driver-fed idle gaps contributing here remains a hypothesis.

## Verification

An independent runner passed all10 focused tests (three control, five resume and two full-summary tests) and four syntax checks. It recomputed all six GPU/render/combined CPU distributions, median-of-three comparisons and raw SHA without importing the summarizer; they match. It verified AB/BA/AB identity/camera/count/zero-error/disjoint/pending guards and both immutable failed60/quiet6 hashes. The three control tests cover actual original selection under both labels, selector drift rejection, immutable raw/label handling, numeric reporting and refusal of selected identity or incomplete/wrong sequence. The generator test initially failed before its module existed. No browser fanout or full suite was run.
