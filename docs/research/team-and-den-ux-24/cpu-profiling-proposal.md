# Bao measurement diagnosis: supported proposal

**Review requested; no further capture is authorized by this document.** Keep the original failed60 verdict and every control. Production/art remain unchanged, Meshy spending stays65/100 existing credits and $0 purchases, and Jev/jg/TypeSafe remain unused.

## Evidence and purpose

The same-context original-only control passes the original median-of-three comparison (GPU+1.15%, combinedCPU−0.51%), but pair2 fails its separate predeclared repeatability guard (GPU+19.15%, CPU+12.18%). Both blocks use the same original asset and1537draw calls. The previous fresh-context control showed a29.07% apparent median GPU improvement with identical assets. These findings do not accept or absolve the replacement.

Read-only availability checks now confirm thread-time fields on80.7% of sample-window renderer task spans and usable non-sensitive Windows CPU counters. No system changes or new capture were needed; see `profiling-availability.md`.

## Recommended bounded diagnostic

- **Effort:** up to2focused hours of preparation/analysis, stopping with a finding or explicit limitation. No purchases, dependencies, administrator session or system settings changes.
- **Capture:** one preregistered six-block original/original run matching the calibration sequence AB/BA/AB,10s warmup+30s sample per block, seven-minute native deadline. About five quiet minutes once the tested driver is ready; obtain fresh readiness then. No retry or optional extra blocks.
- **Task timing log:** own test browser only, using supported renderer-task/user-mark/GC categories. Exclude `gpu.service`, broad GPU traces, screenshots, event argument payloads, stacks, input, environment and process command lines. Predeclare a structural numeric-field filter for renderer task spans and markers; retain all qualifying spans, their names/category/IDs and present `ts/dur/tts/tdur` values, plus missing-field counts. This is a compact diagnostic timing log, not a complete Chrome trace. Prove filter/clock/coverage behavior with fixtures before capture; do not filter by duration or outcome. Cap total saved diagnostic output at64MiB and stop at the cap, preserving partial output explicitly.
- **Timing rows:** preserve the existing query calls/frequency and elapsed/render/animation arithmetic. Add only IDs and CPU issue/availability timestamps; no new GL polling, flush, finish or synchronization. Save each complete timing row before fallible trace finalization. Keep every row/query/outlier, and verify identity, camera, actor and callback/workload counts and logical scene phase.
- **CPU telemetry:** one file-based helper with literal arguments samples only the supported aggregate CPU performance/utility/frequency fields at a declared cadence (proposed5s). Record actual counter semantics, monotonic/UTC anchors and logger overhead. Do not treat SMBIOS clock data as instantaneous per-core frequency. Missing counters or fields remain explicit limitations; no workaround or unrelated process inspection/control.
- **Analysis:** align query intervals with enclosing renderer task spans and compare wall/thread durations without double-counting nested spans or imputing missing CPU times. Retain coverage and timing resolution. Diagnostic instrumentation has overhead, so these rows cannot replace acceptance measurements. Close only owned browser/server/logger on success, failure, cap or deadline.

Ranked predictions, not established causes:

1. Scheduling/waiting: higher wall spans with relatively stable enclosing thread CPU duration would support a waiting/scheduling contribution; it would not identify the exact preemptor.
2. Actual CPU workload or performance change: higher thread CPU work or counter changes alongside stable draw counts would distinguish this from a wall-only delay. Scene phase/branch work remains a competing explanation.
3. Submission/driver timing: GPU elapsed or availability changes without comparable CPU/task changes would leave queue/batching behavior plausible. These measurements still cannot establish physical GPU busy time.

If the high mode does not recur, record that result and stop without a causal claim. Deliver the bounded findings and a separate next-method forecast; do not automatically run A/B/full60 or relax the approved5%limits, repetitions, durations, state coverage or cold-resource accounting.

## Alternative

The existing `next-measurement-method-draft.md` describes a fixed12-block A/A precision study (about9–12quiet minutes and45–90minutes prep/analysis). It characterizes repeatability rather than cause and does not change the three-repetition acceptance rule. It requires its own reviewed choice before capture.
