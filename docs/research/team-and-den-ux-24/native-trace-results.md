# Bao tracing results: one complete trace, second capped

The single corrected retry captured one complete original-Bao trace. Its second trace hit the256MiB total output cap. No third trace or acceptance rerun occurred. Root released the quiet-host condition. The original five acceptance timing failures remain failed.

Initial `native-trace/` artifacts preserve a zero-sample startup failure. Chrome returned a valid empty category array; our unsupported discovery assumption caused the refusal. Root authorized directly requesting the six fixed categories, then checking actual events. A regression was red before that correction and green afterward. `native-trace-retry/` preserves the separately predeclared retry: at most two original-only meeting-light runs,10s warmup +30s sample,180s total and256MiB combined output, unchanged GL calls/query placement/every-third-frame frequency/availability polling. It adds diagnostic CPU timestamps/IDs and sample clock marks. No flush/finish, metric substitution, screenshot, network body, user input, environment/key inspection, unrelated app control, Meshy spend or production/art/system change occurred.

Complete A trace173,809,893bytes; partial B94,371,840bytes. Combined268,181,733≤268,435,456byte cap; the next chunk was refused. B is incomplete and not analyzed. B's sampled row was unsaved because trace finalization threw before row persistence; it cannot be recovered. Future generator ordering now saves observations before finalization, covered by a regression. Executed harness/raw hashes stay unchanged. This administrative loss is explicit, not a performance-based exclusion.

Browser cleanup completed. Owned initial/retry serversPIDs10282/46141 stopped;4425 verified closed. Router/service and unrelated processes untouched.

## Valid A metrics

901frames,301GPU queries,42actors/4visitors/6guests; zero errors/writes/disjoint/pending queries or trace data loss. Original manifest/model/species guards pass. Real trace contains two sample marks spanning30.019s,53,542duration-bearing renderer-main-thread task spans,571,945GPU events and36,017GPU-service events. Empty discovery did not prevent actual coverage.

| Metric | p50 | p95 | Range |
| --- | ---: | ---: | ---: |
| GPU elapsed ms | 3.280896 | 4.042752 | 3.156992–4.895744 |
| Render CPU ms | 10.80 | 14.20 | 9.10–19.30 |
| Combined render+animation CPU ms | 12.70 | 16.70 | 10.90–21.30 |
| CPU query begin/end interval ms | 10.90 | 14.10 | 9.20–18.70 |
| Query availability after CPU end,ms | 33.30 | 37.70 | 26.20–40.90 |
| Resolve-frame index lag | 1 | 1 | 0–1 |

GPU elapsed versus CPU submission Pearson r=0.2713244333(n301). All301GPU queries are≤6ms; no high mode was captured in the valid trace. There are4,615nested duration-bearing GC-related main-thread spans and zero overlaps with301CPU issue intervals. Those spans are not independent collections; broader GC effects are not excluded. Sample marks align CPU query timestamps to trace time; query/frame IDs preserve all observations.

GPU/service events include command-buffer flushes, ordering barriers, scheduler tasks, WebGL processing and presentation. Their durations are not hardware busy time. Elapsed query durations lack absolute device start timestamps, so CPU markers cannot place GPU execution on the trace clock. The trace shows asynchronous availability and low elapsed time while CPU submission is longer; it cannot establish why earlier samples switched modes or a driver/CPU/GC/asset cause. Observer overhead excludes these samples from acceptance.

The bounded streaming event parser verifies real marks/task/category counts and handles nested/escaped/adjacent JSON objects; no whole-trace analysis parse. All query distributions and correlations are in `native-trace-statistics.json`. Low/middle/high buckets retain every query and are not pass filters. Independent runner recomputation matches GPU/render/combinedCPU/submission/availability percentiles and Pearsonr. Eight focused tests and six syntax checks pass. Failed60/quiet6/identical6 remain preserved separately.

## Label audit and next step

All three prior A/A B-label p95s were lower, including reversed rep2; this sign consistency is unresolved. The exact retained harness uses `baseline` only for pair order, an unused resume filter, error/result/log metadata and a post-sample screenshot filename. It is not passed into fixtures/page collection. Both model/portrait routes are unconditional original selection. No label-specific collector/query/count/budget/GC branch remains. Retry labels similarly affect only order/metadata/trace filename. Lifecycle/cache/scheduling/pose-phase effects remain possible.

The [same-context measurement plan](measurement-plan-draft.md) is a temporary-observer feasibility draft for root to classify against the approved recipe. Actual relaxations or metric/system/cost changes remain user gates. No repeated traces hoping to catch a mode, profiler installation or full rerun is authorized by this report.
