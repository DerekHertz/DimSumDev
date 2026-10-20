# Bao native trace startup checkpoint

Historical startup checkpoint, superseded: root identified the nonempty-discovery assumption as a local observer bug and authorized one bounded retry. See [complete results](native-trace-results.md). The original failed startup artifacts remain unchanged; the retry captured one valid trace before its second trace hit the strict output cap. No further capture is authorized in this round.

**No trace or performance sample was collected.** The predeclared two-run original-only diagnostic stopped before creating a page because native Chrome returned `categories: []` from `Tracing.getCategories`. The harness filtered its requested categories through that empty list, then refused the missing required `devtools.timeline` category. Browser cleanup completed and the owned serverPID10282 stopped;4425 was verified closed. No retry or category-discovery workaround was attempted.

The failed startup is preserved under external `native-trace/`: plan, generated harness, exact failure and source metadata. Its plan allowed at most two original-Bao meeting-light runs,10s warmup +30s sample,180s capture deadline and256MiB total trace output. Requested categories were `devtools.timeline`, `v8`, `gpu`, `disabled-by-default-gpu.service`, `blink.user_timing` and `toplevel`; the latter two align owned sample markers and task execution. No screenshots, network bodies, user input, environment/credentials or unrelated application control were requested. No Jev/TypeSafe call, Meshy spend or runtime/art change occurred.

## Exact discovery handling and limits

The generated program uses `(await traceCDP.send('Tracing.getCategories')).categories`. Retained `availableTraceCategories` and filtered `traceCategories` are both empty arrays. This proves the `categories` property was an empty array, rather than missing or the wrong type; either of those would fail at `.includes` earlier. Full response-object keys were not saved. The local field lookup matches the expected result shape; no local schema/lookup defect was found. Empty discovery does not establish that Chrome cannot emit the requested events, nor that they are supported. It leaves coverage unknown. No causal performance conclusion follows from this startup failure.

New diagnostic-only observer preparation adds frame/query identities, CPU-side begin/end timestamps, availability timestamps and resolve-frame indices while retaining every existing GL query call and every-third-frame frequency. It adds no `flush`, `finish`, synchronous query waits or substitute GPU metric. Marker-to-trace clock alignment and runtime query correlation remain **unverified**, because refusal occurred before page creation. These samples would have trace overhead and could never replace acceptance samples.

## Label-correlated A/A result audit

All three earlier A/A B-label GPU p95s were lower, including reversed rep2. This sign consistency warrants investigation; it is not dismissed as random noise. Exact review of retained `identical-control/native-performance.cjs` finds the `baseline` Boolean only in: pair iteration/order; a resume-only filter (no resume argument was supplied); page-error metadata; saved result/log labels; and the screenshot filename after each measured sample. It is not passed into the fixture or page collector. Both manifest and portrait routes are unconditional original selection. Each context gets the same instrumentation/query setup; no baseline-specific timing, route, actor-count, budget or GC branch remains.

The native-trace harness similarly uses the Boolean only for iteration, unused resume filtering, metadata/log labels and trace output filename. It does not branch the observed workload. Unobserved context lifecycle/cache/scheduling/pose-phase effects remain possible. There is no demonstrated explanation for the consistent A/A sign.

## Concrete proposed discovery/coverage revision; not applied

The environment gate requires user agreement before dependent retry. Keep the failed startup files intact and write a new predeclared folder if approved. Retain the same at-most-two original-only samples,10s+30s recipe,180s bound,256MiB cap, privacy scope, unchanged GL call/query strategy and all original identity/frame/error guards. Change only discovery policy:

```diff
- selected = requested.filter(category => discovered.includes(category));
- assert(selected.includes('devtools.timeline'));
- assert(selected.includes('blink.user_timing'));
+ record({discovered, requested, discoveryIsEmpty: discovered.length === 0});
+ selected = requested; // request exactly the six declared categories, not a wildcard
+ // After streaming each trace, verify actual event coverage before any next run.
+ require(ownedStartAndEndMarks && rendererTaskEvents && gpuOrGpuServiceEvents);
+ report(requestedCategoriesWithNoEvents);
```

Implement actual coverage with parsed event `cat` values, owned `bao24-sample-start`/`bao24-sample-end` marks, duration-bearing renderer task events and GPU/service events. Report metadata thread/process names and category counts only; retain the owned raw trace locally. If required coverage is absent or any identity/sample/data-loss/output guard fails, stop after the first attempted sample and report the limit; no automatic retry. Structural tests should cover empty discovery, present discovery, missing marks/CPU/GPU events and cap/data-loss refusal. Successful category coverage is not proof of continuous device-busy attribution. GPU-service CPU events alone cannot be relabeled GPU execution time.

If approved traces expose correlated CPU submission/GC/scheduling, draft the narrowest justified collector or sampling correction. If they cannot expose device busy intervals, state that limitation and seek agreement on a native device trace rather than changing the acceptance metric. No `flush`/`finish` proposal is authorized here: forced submission changes command batching and what is being measured.

Before any full60 rerun, root/user should agree a concrete unchanged-asset calibration recipe: three original/original pairs AB/BA/AB, all rows retained, same10s+30s/full-sample guards, observed camera matrices/counts/pose-state evidence; proposed absolute median-of-three and paired GPU/combinedCPU p95 differences≤5%. A failed calibration holds the full rerun. Any protocol revision must state whether it still measures normal production rendering, its observation overhead and which CPU/GPU cost is excluded. The five original acceptance failures stay failed; failed60, quiet6 and identical6 are preserved separately.

## Environment issues

Exact startup error: `AssertionError [ERR_ASSERTION]: assert.ok(results.traceCategories.includes('devtools.timeline'))`; discovery and selected lists were empty. No automatic approval rejection or timeout. Suggested fix is the reviewable requested-category/observed-event-coverage proposal above, subject to user agreement; no dependent workaround was performed.
